/**
 * RadioParty server — integration-level tests.
 *
 * Tests exercise the RadioParty class through its public interface
 * (onConnect, onMessage, onRequest) with a minimal mock of the
 * PartyKit Room / Connection / Storage APIs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import RadioParty from "../index"
import type * as Party from "partykit/server"

// ─── Mock helpers ─────────────────────────────────────────────────────────────

interface MockRoom {
  id: string
  storage: {
    get: ReturnType<typeof vi.fn>
    put: ReturnType<typeof vi.fn>
    setAlarm: ReturnType<typeof vi.fn>
  }
  broadcast: ReturnType<typeof vi.fn>
  getConnections: ReturnType<typeof vi.fn>
  env: Record<string, unknown>
  _store: Map<string, unknown>
  _broadcasts: string[]
}

function createMockRoom(id: string, initialStorage: Record<string, unknown> = {}): MockRoom {
  const store = new Map<string, unknown>(Object.entries(initialStorage))
  const broadcasts: string[] = []

  const room: MockRoom = {
    id,
    env: {},
    _store: store,
    _broadcasts: broadcasts,
    storage: {
      get: vi.fn(async (key: string) => store.get(key) ?? undefined),
      put: vi.fn(async (key: string, value: unknown) => { store.set(key, value) }),
      setAlarm: vi.fn(async (_time: number) => {}),
    },
    broadcast: vi.fn((msg: string) => { broadcasts.push(msg) }),
    getConnections: vi.fn(() => []),
  }
  return room
}

interface MockConn {
  id: string
  uri: string
  send: ReturnType<typeof vi.fn>
  _sent: string[]
}

function createMockConn(id: string, uri = "ws://localhost:1999/parties/main/test-station"): MockConn {
  const sent: string[] = []
  return {
    id,
    uri,
    send: vi.fn((msg: string) => { sent.push(msg) }),
    _sent: sent,
  }
}

/** Decode the most recent broadcast payload. */
function lastBroadcast(room: MockRoom): any {
  const last = room._broadcasts[room._broadcasts.length - 1]
  return last ? JSON.parse(last) : null
}

/** Decode the most recent message sent to a connection. */
function lastSent(conn: MockConn): any {
  const last = conn._sent[conn._sent.length - 1]
  return last ? JSON.parse(last) : null
}

/** Helper: send a WebSocket message to a RadioParty instance. */
async function send(party: RadioParty, msg: object, conn: MockConn): Promise<void> {
  await party.onMessage(JSON.stringify(msg), conn as unknown as Party.Connection)
}

/** Build a minimal Track payload. */
function makeTrack(overrides: Partial<Record<string, unknown>> = {}): object {
  return {
    isrc: "USAT21900001",
    platformIds: { apple: "1234567890" },
    addedViaPlatform: "apple",
    name: "Test Song",
    artistName: "Test Artist",
    albumName: "Test Album",
    artworkUrl: "https://example.com/art/{w}x{h}bb.jpg",
    durationMs: 200_000,
    ...overrides,
  }
}

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  // Suppress network calls made by notifyIndex / notifyIndexPresence
  vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")))
  // Make crypto.randomUUID predictable in tests
  let seq = 0
  vi.stubGlobal("crypto", {
    randomUUID: () => `key-${++seq}`,
    getRandomValues: (buf: Uint8Array) => buf,
  })
})

// ─── Queue insertion ──────────────────────────────────────────────────────────

describe("add_track", () => {
  it("adds the first user track and sets expirationTime = now + durationMs", async () => {
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "owner-1", displayName: "DJ Owner" }, conn)

    const before = Date.now()
    await send(party, { type: "add_track", track: makeTrack({ durationMs: 200_000 }), addedBy: "owner-1" }, conn)
    const after = Date.now()

    const queue = room._store.get("queue") as any[]
    expect(queue).toHaveLength(1)
    expect(queue[0].name).toBe("Test Song")
    expect(queue[0].addedBy).toBe("owner-1")
    expect(queue[0].expirationTime).toBeGreaterThanOrEqual(before + 200_000)
    expect(queue[0].expirationTime).toBeLessThanOrEqual(after + 200_000)
  })

  it("inserts a second user track after the first, expiry chained", async () => {
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "owner-1", displayName: "DJ Owner" }, conn)
    await send(party, { type: "add_track", track: makeTrack({ durationMs: 200_000, isrc: "ISRC001", name: "Track 1", platformIds: { apple: "111" } }), addedBy: "owner-1" }, conn)
    await send(party, { type: "add_track", track: makeTrack({ durationMs: 180_000, isrc: "ISRC002", name: "Track 2", platformIds: { apple: "222" } }), addedBy: "owner-1" }, conn)

    const queue = room._store.get("queue") as any[]
    expect(queue).toHaveLength(2)
    expect(queue[1].name).toBe("Track 2")
    // Track 2's expiry should equal Track 1's expiry + Track 2's duration
    expect(queue[1].expirationTime).toBe(queue[0].expirationTime + 180_000)
  })

  it("robot tracks always append at the tail, after user tracks", async () => {
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "owner-1", displayName: "DJ Owner" }, conn)

    // Add a user track first
    await send(party, { type: "add_track", track: makeTrack({ durationMs: 200_000, isrc: "USR01", platformIds: { apple: "u1" }, name: "User Track" }), addedBy: "owner-1" }, conn)
    // Add a robot track
    await send(party, { type: "add_track", track: makeTrack({ durationMs: 200_000, isrc: "ROB01", platformIds: { apple: "r1" }, name: "Robot Track" }), addedBy: "robot" }, conn)
    // Add another user track — should insert BEFORE the robot track
    await send(party, { type: "add_track", track: makeTrack({ durationMs: 200_000, isrc: "USR02", platformIds: { apple: "u2" }, name: "User Track 2" }), addedBy: "owner-1" }, conn)

    const queue = room._store.get("queue") as any[]
    expect(queue).toHaveLength(3)
    expect(queue[0].name).toBe("User Track")
    expect(queue[1].name).toBe("User Track 2")
    expect(queue[2].name).toBe("Robot Track")
  })

  it("broadcasts a queue_update after adding a track", async () => {
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "owner-1", displayName: "DJ" }, conn)

    room._broadcasts.length = 0  // clear setup broadcasts
    await send(party, { type: "add_track", track: makeTrack(), addedBy: "owner-1" }, conn)

    const update = room._broadcasts.find(b => JSON.parse(b).type === "queue_update")
    expect(update).toBeDefined()
    const parsed = JSON.parse(update!)
    expect(parsed.queue).toHaveLength(1)
  })
})

// ─── Queue expiration ─────────────────────────────────────────────────────────

describe("expire_track", () => {
  it("removes queue[0] and adds it to the pool (addToPool=true)", async () => {
    const firstExpiry = Date.now() + 200_000
    // No platform ID → hasAnyPlatformId returns false → robot DJ cannot reuse this track,
    // so the queue stays empty after expiry (no robot refill side-effect in this test).
    const track = {
      key: "track-key-1",
      expirationTime: firstExpiry,
      addedBy: "owner-1",
      addedAt: Date.now(),
      isrc: "USAT001",
      platformIds: {},
      addedViaPlatform: "apple",
      name: "Song A",
      artistName: "Artist",
      albumName: "Album",
      artworkUrl: "",
      durationMs: 200_000,
    }
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
      queue: [track],
      pool: [],
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "expire_track", key: "track-key-1", addToPool: true }, conn)

    const queue = room._store.get("queue") as any[]
    const pool = room._store.get("pool") as any[]
    expect(queue).toHaveLength(0)
    expect(pool).toHaveLength(1)
    expect(pool[0].name).toBe("Song A")
    expect(pool[0].playCount).toBe(1)
  })

  it("removes queue[0] without adding to pool (addToPool=false)", async () => {
    // No platform ID → robot cannot refill → pool stays empty and verifiable
    const track = {
      key: "track-key-1",
      expirationTime: Date.now() + 200_000,
      addedBy: "owner-1",
      addedAt: Date.now(),
      isrc: "USAT001",
      platformIds: {},
      addedViaPlatform: "apple",
      name: "Song A",
      artistName: "Artist",
      albumName: "Album",
      artworkUrl: "",
      durationMs: 200_000,
    }
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
      queue: [track],
      pool: [],
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "expire_track", key: "track-key-1", addToPool: false }, conn)

    const pool = room._store.get("pool") as any[]
    expect(pool).toHaveLength(0)
  })

  it("ignores stale expire_track for a key that is no longer queue[0]", async () => {
    const track1 = {
      key: "key-a",
      expirationTime: Date.now() + 100_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "ISRC-A", platformIds: { apple: "111" },
      addedViaPlatform: "apple", name: "Song A",
      artistName: "", albumName: "", artworkUrl: "", durationMs: 100_000,
    }
    const track2 = {
      key: "key-b",
      expirationTime: Date.now() + 200_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "ISRC-B", platformIds: { apple: "222" },
      addedViaPlatform: "apple", name: "Song B",
      artistName: "", albumName: "", artworkUrl: "", durationMs: 100_000,
    }
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
      queue: [track1, track2],
      pool: [],
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    // Send stale expire for key-b (which is queue[1], not queue[0])
    await send(party, { type: "expire_track", key: "key-b", addToPool: true }, conn)

    const queue = room._store.get("queue") as any[]
    // Queue unchanged — stale message ignored
    expect(queue).toHaveLength(2)
    expect(queue[0].key).toBe("key-a")
  })

  it("increments playCount when the same track is expired into the pool a second time", async () => {
    // No platform ID so the robot DJ cannot turn around and re-queue the track,
    // keeping the pool state simple and predictable in this test.
    const existingPool = [{
      isrc: "USAT001",
      platformIds: {},
      addedViaPlatform: "apple",
      name: "Song A",
      artistName: "Artist",
      albumName: "Album",
      artworkUrl: "",
      durationMs: 200_000,
      lastPlayedAt: Date.now() - 60_000,
      addedByUsers: ["owner-1"],
      playCount: 1,
    }]
    const track = {
      key: "track-key-1",
      expirationTime: Date.now() + 200_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "USAT001", platformIds: {},
      addedViaPlatform: "apple", name: "Song A",
      artistName: "Artist", albumName: "Album",
      artworkUrl: "", durationMs: 200_000,
    }
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
      queue: [track],
      pool: existingPool,
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "expire_track", key: "track-key-1", addToPool: true }, conn)

    const pool = room._store.get("pool") as any[]
    expect(pool).toHaveLength(1)
    expect(pool[0].playCount).toBe(2)
  })
})

// ─── Queue reordering ─────────────────────────────────────────────────────────

describe("reorder_queue", () => {
  it("reorders user tracks while keeping the robot tail at the end", async () => {
    const nowPlaying = {
      key: "np", expirationTime: Date.now() + 200_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "NP", platformIds: { apple: "0" }, addedViaPlatform: "apple",
      name: "Now Playing", artistName: "", albumName: "", artworkUrl: "", durationMs: 200_000,
    }
    const user1 = {
      key: "u1", expirationTime: Date.now() + 400_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "U1", platformIds: { apple: "1" }, addedViaPlatform: "apple",
      name: "User 1", artistName: "", albumName: "", artworkUrl: "", durationMs: 200_000,
    }
    const user2 = {
      key: "u2", expirationTime: Date.now() + 600_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "U2", platformIds: { apple: "2" }, addedViaPlatform: "apple",
      name: "User 2", artistName: "", albumName: "", artworkUrl: "", durationMs: 200_000,
    }
    const robot = {
      key: "r1", expirationTime: Date.now() + 800_000,
      addedBy: "robot", addedAt: Date.now(),
      isrc: "R1", platformIds: { apple: "3" }, addedViaPlatform: "apple",
      name: "Robot 1", artistName: "", albumName: "", artworkUrl: "", durationMs: 200_000,
    }
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
      queue: [nowPlaying, user1, user2, robot],
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "owner-1", displayName: "DJ" }, conn)
    // Swap user1 and user2
    await send(party, { type: "reorder_queue", keys: ["u2", "u1"] }, conn)

    const queue = room._store.get("queue") as any[]
    expect(queue[0].key).toBe("np")       // now-playing unchanged
    expect(queue[1].key).toBe("u2")       // swapped to front
    expect(queue[2].key).toBe("u1")       // moved back
    expect(queue[3].key).toBe("r1")       // robot tail last
  })

  it("recalculates expiration times for all reordered tracks", async () => {
    const npExpiry = Date.now() + 100_000
    const nowPlaying = {
      key: "np", expirationTime: npExpiry,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "NP", platformIds: { apple: "0" }, addedViaPlatform: "apple",
      name: "Now Playing", artistName: "", albumName: "", artworkUrl: "", durationMs: 100_000,
    }
    const trackA = {
      key: "a", expirationTime: npExpiry + 120_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "A", platformIds: { apple: "1" }, addedViaPlatform: "apple",
      name: "Track A", artistName: "", albumName: "", artworkUrl: "", durationMs: 120_000,
    }
    const trackB = {
      key: "b", expirationTime: npExpiry + 300_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "B", platformIds: { apple: "2" }, addedViaPlatform: "apple",
      name: "Track B", artistName: "", albumName: "", artworkUrl: "", durationMs: 180_000,
    }
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
      queue: [nowPlaying, trackA, trackB],
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "owner-1", displayName: "DJ" }, conn)
    // Swap A and B
    await send(party, { type: "reorder_queue", keys: ["b", "a"] }, conn)

    const queue = room._store.get("queue") as any[]
    // B is now at index 1: expiry = npExpiry + B.durationMs (180k)
    expect(queue[1].expirationTime).toBe(npExpiry + 180_000)
    // A is now at index 2: expiry = npExpiry + B.durationMs + A.durationMs
    expect(queue[2].expirationTime).toBe(npExpiry + 180_000 + 120_000)
  })
})

// ─── Skip track ───────────────────────────────────────────────────────────────

describe("skip_track", () => {
  it("removes queue[0] and promotes queue[1] with recalculated expiry", async () => {
    const nowPlaying = {
      key: "np", expirationTime: Date.now() + 200_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "NP", platformIds: { apple: "0" }, addedViaPlatform: "apple",
      name: "Now Playing", artistName: "", albumName: "", artworkUrl: "", durationMs: 200_000,
    }
    const nextTrack = {
      key: "next", expirationTime: Date.now() + 400_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "NEXT", platformIds: { apple: "1" }, addedViaPlatform: "apple",
      name: "Next Track", artistName: "", albumName: "", artworkUrl: "", durationMs: 200_000,
    }
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
      queue: [nowPlaying, nextTrack],
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "owner-1", displayName: "DJ" }, conn)

    const before = Date.now()
    await send(party, { type: "skip_track" }, conn)

    const queue = room._store.get("queue") as any[]
    expect(queue).toHaveLength(1)
    expect(queue[0].key).toBe("next")
    // New expiry = now + durationMs
    expect(queue[0].expirationTime).toBeGreaterThanOrEqual(before + 200_000)
  })

  it("non-privileged connection cannot skip", async () => {
    const track = {
      key: "np", expirationTime: Date.now() + 200_000,
      addedBy: "owner-1", addedAt: Date.now(),
      isrc: "NP", platformIds: { apple: "0" }, addedViaPlatform: "apple",
      name: "Song", artistName: "", albumName: "", artworkUrl: "", durationMs: 200_000,
    }
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
      queue: [track],
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const ownerConn = createMockConn("conn-owner")
    const listenerConn = createMockConn("conn-listener")

    await party.onConnect(ownerConn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "owner-1", displayName: "Owner" }, ownerConn)
    await party.onConnect(listenerConn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "listener-1", displayName: "Listener" }, listenerConn)

    // Listener tries to skip — should be ignored
    await send(party, { type: "skip_track" }, listenerConn)

    const queue = room._store.get("queue") as any[]
    expect(queue).toHaveLength(1)  // unchanged
  })
})

// ─── DJ management ────────────────────────────────────────────────────────────

describe("grant_dj / revoke_dj", () => {
  it("owner can grant DJ role, which is broadcast to all connections", async () => {
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const ownerConn = createMockConn("conn-owner")

    await party.onConnect(ownerConn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "owner-1", displayName: "Owner" }, ownerConn)

    room._broadcasts.length = 0
    await send(party, { type: "grant_dj", userId: "user-2" }, ownerConn)

    const djs = room._store.get("djs") as string[]
    expect(djs).toContain("user-2")

    const djUpdate = room._broadcasts.find(b => JSON.parse(b).type === "dj_update")
    expect(djUpdate).toBeDefined()
    expect(JSON.parse(djUpdate!).djs).toContain("user-2")
  })

  it("owner can revoke DJ role", async () => {
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
      djs: ["user-2"],
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const ownerConn = createMockConn("conn-owner")

    await party.onConnect(ownerConn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "owner-1", displayName: "Owner" }, ownerConn)
    await send(party, { type: "revoke_dj", userId: "user-2" }, ownerConn)

    const djs = room._store.get("djs") as string[]
    expect(djs).not.toContain("user-2")
  })

  it("non-owner cannot grant DJ role", async () => {
    const room = createMockRoom("test-station", {
      ownership: { ownerUid: "owner-1", createdAt: Date.now() },
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const nonOwnerConn = createMockConn("conn-other")

    await party.onConnect(nonOwnerConn as unknown as Party.Connection)
    await send(party, { type: "join", userId: "user-99", displayName: "Outsider" }, nonOwnerConn)
    await send(party, { type: "grant_dj", userId: "user-99" }, nonOwnerConn)

    const djs = (room._store.get("djs") as string[] | undefined) ?? []
    expect(djs).not.toContain("user-99")
  })
})

// ─── Index room ───────────────────────────────────────────────────────────────

describe("index room — register / remove_station", () => {
  it("register adds a new station to the list and broadcasts", async () => {
    const room = createMockRoom("index", { stations: [] })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1", "ws://localhost:1999/parties/main/index")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, {
      type: "register",
      id: "my-station",
      displayName: "My Station",
      storefront: "us",
      ownerUid: "user-1",
    }, conn)

    const stations = room._store.get("stations") as any[]
    expect(stations).toHaveLength(1)
    expect(stations[0].id).toBe("my-station")
    expect(stations[0].displayName).toBe("My Station")
  })

  it("remove_station deletes the station and broadcasts", async () => {
    const room = createMockRoom("index", {
      stations: [{ id: "my-station", displayName: "My Station", storefront: "us", liveUntil: 0 }],
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, { type: "remove_station", id: "my-station" }, conn)

    const stations = room._store.get("stations") as any[]
    expect(stations).toHaveLength(0)
  })

  it("register updates an existing station's display name", async () => {
    const room = createMockRoom("index", {
      stations: [{ id: "my-station", displayName: "Old Name", storefront: "us", liveUntil: 0 }],
    })
    const party = new RadioParty(room as unknown as Party.Room)
    const conn = createMockConn("conn-1")

    await party.onConnect(conn as unknown as Party.Connection)
    await send(party, {
      type: "register",
      id: "my-station",
      displayName: "New Name",
      storefront: "us",
    }, conn)

    const stations = room._store.get("stations") as any[]
    expect(stations).toHaveLength(1)
    expect(stations[0].displayName).toBe("New Name")
  })
})

// ─── Station creation (HTTP) ──────────────────────────────────────────────────

describe("onRequest — station creation", () => {
  it("POST /create stores ownership and returns 200", async () => {
    const room = createMockRoom("new-station")
    const party = new RadioParty(room as unknown as Party.Room)

    const req = {
      method: "POST",
      url: "https://host/parties/main/new-station/create",
      json: async () => ({ ownerUid: "user-1", displayName: "My Station", storefront: "us" }),
    } as unknown as Party.Request

    const res = await party.onRequest(req)
    expect(res.status).toBe(200)

    const ownership = room._store.get("ownership") as any
    expect(ownership.ownerUid).toBe("user-1")
  })

  it("POST /create returns 409 when station already exists", async () => {
    const room = createMockRoom("existing-station", {
      ownership: { ownerUid: "user-1", createdAt: Date.now() },
    })
    const party = new RadioParty(room as unknown as Party.Room)

    const req = {
      method: "POST",
      url: "https://host/parties/main/existing-station/create",
      json: async () => ({ ownerUid: "user-2", displayName: "Duplicate", storefront: "us" }),
    } as unknown as Party.Request

    const res = await party.onRequest(req)
    expect(res.status).toBe(409)
  })

  it("GET /index?check=<slug> returns taken=true when slug exists", async () => {
    const room = createMockRoom("index", {
      stations: [{ id: "taken-slug", displayName: "Taken", storefront: "us", liveUntil: 0 }],
    })
    const party = new RadioParty(room as unknown as Party.Room)

    const req = {
      method: "GET",
      url: "https://host/parties/main/index?check=taken-slug",
    } as unknown as Party.Request

    const res = await party.onRequest(req)
    const body = await res.json() as { taken: boolean }
    expect(body.taken).toBe(true)
  })

  it("GET /index?check=<slug> returns taken=false when slug is available", async () => {
    const room = createMockRoom("index", { stations: [] })
    const party = new RadioParty(room as unknown as Party.Room)

    const req = {
      method: "GET",
      url: "https://host/parties/main/index?check=free-slug",
    } as unknown as Party.Request

    const res = await party.onRequest(req)
    const body = await res.json() as { taken: boolean }
    expect(body.taken).toBe(false)
  })
})
