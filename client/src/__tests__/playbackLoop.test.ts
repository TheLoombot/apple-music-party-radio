/**
 * Tests for PlaybackLoop — the client-side sync engine.
 *
 * PlaybackLoop depends on:
 *   - stationSocket (from ./partykit) — mocked module
 *   - MusicPlayer interface — controlled mock object
 *   - musickit module (onNowPlayingItemChange, isPreviewOnly) — mocked
 *
 * The private handleQueueUpdate method is exercised by triggering
 * stationSocket.onQueueUpdate directly after calling start().
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { PlaybackLoop } from "../services/playbackLoop"
import { UnavailableError } from "../services/player"
import type { MusicPlayer } from "../services/player"
import type { QueueItem } from "../types"

// ─── Module mocks ─────────────────────────────────────────────────────────────

// vi.mock is hoisted to the top of the file, so all variables it references
// must be created with vi.hoisted() to avoid temporal-dead-zone errors.
const mockStationSocket = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  expireTrack: vi.fn(),
  triggerRobotDJ: vi.fn(),
  onQueueUpdate: undefined as any,
}))

vi.mock("../services/partykit", () => ({
  stationSocket: mockStationSocket,
}))

const mockIsPreviewOnly = vi.hoisted(() => vi.fn(() => false))

vi.mock("../services/musickit", () => ({
  onNowPlayingItemChange: (cb: (item: any) => void) => {
    // Store callback for tests that want to fire native-advance events
    return () => {}
  },
  isPreviewOnly: () => mockIsPreviewOnly(),
}))

// ─── Player mock factory ──────────────────────────────────────────────────────

function createMockPlayer(): MusicPlayer & {
  playAtOffset: ReturnType<typeof vi.fn>
  syncQueueTail: ReturnType<typeof vi.fn>
  getLiveCurrentId: ReturnType<typeof vi.fn>
  isPlaying: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  setVolume: ReturnType<typeof vi.fn>
} {
  return {
    playAtOffset: vi.fn(async () => {}),
    syncQueueTail: vi.fn(async () => {}),
    getLiveCurrentId: vi.fn(() => null),
    isPlaying: vi.fn(() => false),
    stop: vi.fn(),
    setVolume: vi.fn(),
  }
}

// ─── Track factory ────────────────────────────────────────────────────────────

function makeQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  const now = Date.now()
  return {
    key: "item-key",
    expirationTime: now + 200_000,
    addedBy: "user-1",
    addedAt: now,
    isrc: "USAT001",
    platformIds: { apple: "1234567890" },
    addedViaPlatform: "apple",
    name: "Test Song",
    artistName: "Test Artist",
    albumName: "Test Album",
    artworkUrl: "",
    durationMs: 200_000,
    ...overrides,
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Trigger a queue update through the registered callback. */
async function triggerQueueUpdate(queue: QueueItem[]): Promise<void> {
  await mockStationSocket.onQueueUpdate?.(queue)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks()
  // Reset the callback so each test starts clean
  mockStationSocket.onQueueUpdate = undefined
})

afterEach(() => {
  vi.clearAllTimers()
})

// ─── Hard switch (new track[0]) ───────────────────────────────────────────────

describe("handleQueueUpdate — hard switch", () => {
  it("calls playAtOffset with a calculated sync offset", async () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    loop.enableAutoplay()
    loop.start("station-1")

    const now = Date.now()
    const durationMs = 200_000
    const expirationTime = now + durationMs / 2   // 100 s remaining → offset should be ~100 s
    const track = makeQueueItem({ expirationTime, durationMs })

    await triggerQueueUpdate([track])

    expect(player.playAtOffset).toHaveBeenCalledOnce()
    const [calledTrack, calledOffset] = player.playAtOffset.mock.calls[0] as [QueueItem, number, QueueItem[]]
    expect(calledTrack.key).toBe(track.key)
    // offset = max(0, (now - startTime) / 1000) where startTime = expiry - duration
    // startTime ≈ now - durationMs/2, so offset ≈ durationMs/2/1000 = 100 s
    expect(calledOffset).toBeGreaterThanOrEqual(95)  // allow a few ms of test overhead
    expect(calledOffset).toBeLessThanOrEqual(105)
    loop.stop()
  })

  it("immediately expires a track whose expirationTime is already in the past", async () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    loop.enableAutoplay()
    loop.start("station-1")

    const expiredTrack = makeQueueItem({
      key: "expired-key",
      expirationTime: Date.now() - 1000,  // 1 second in the past
    })

    await triggerQueueUpdate([expiredTrack])

    // Must not try to play an already-expired track
    expect(player.playAtOffset).not.toHaveBeenCalled()
    // Must tell the server to expire it
    expect(mockStationSocket.expireTrack).toHaveBeenCalledWith("expired-key", true)
    loop.stop()
  })

  it("stores pendingPlay and fires onPlaybackBlocked when autoplay is not enabled", async () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    // NOT calling loop.enableAutoplay()

    const blocked = vi.fn()
    loop.onPlaybackBlocked = blocked
    loop.start("station-1")

    const track = makeQueueItem()
    await triggerQueueUpdate([track])

    expect(player.playAtOffset).not.toHaveBeenCalled()
    expect(blocked).toHaveBeenCalledOnce()
    loop.stop()
  })
})

// ─── Soft update (same track[0]) ──────────────────────────────────────────────

describe("handleQueueUpdate — soft update", () => {
  it("only syncs the tail when track[0] is unchanged", async () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    loop.enableAutoplay()
    loop.start("station-1")

    const track = makeQueueItem({ key: "same-key" })
    const tail1 = makeQueueItem({ key: "tail-a", name: "Tail A" })
    const tail2 = makeQueueItem({ key: "tail-b", name: "Tail B" })

    // First update — hard switch
    await triggerQueueUpdate([track, tail1])
    expect(player.playAtOffset).toHaveBeenCalledOnce()
    player.playAtOffset.mockClear()
    player.syncQueueTail.mockClear()

    // Second update — same track[0], different tail
    await triggerQueueUpdate([track, tail2])

    expect(player.playAtOffset).not.toHaveBeenCalled()
    expect(player.syncQueueTail).toHaveBeenCalledOnce()
    const [tailArg] = player.syncQueueTail.mock.calls[0] as [QueueItem[]]
    expect(tailArg[0].key).toBe("tail-b")
    loop.stop()
  })
})

// ─── Empty queue ──────────────────────────────────────────────────────────────

describe("handleQueueUpdate — empty queue", () => {
  it("calls player.stop() and fires onNowPlayingChange(null)", async () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    loop.enableAutoplay()
    loop.start("station-1")

    const nowPlayingChange = vi.fn()
    loop.onNowPlayingChange = nowPlayingChange

    // Prime with a track first, then clear
    const track = makeQueueItem()
    await triggerQueueUpdate([track])
    await triggerQueueUpdate([])

    expect(player.stop).toHaveBeenCalled()
    expect(nowPlayingChange).toHaveBeenLastCalledWith(null)
    loop.stop()
  })

  it("triggers robot DJ when queue empties", async () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    loop.enableAutoplay()
    loop.start("station-1")

    await triggerQueueUpdate([])
    expect(mockStationSocket.triggerRobotDJ).toHaveBeenCalled()
    loop.stop()
  })
})

// ─── UnavailableError handling ────────────────────────────────────────────────

describe("UnavailableError handling", () => {
  it("expires track with addToPool=false when playAtOffset throws UnavailableError", async () => {
    const player = createMockPlayer()
    const track = makeQueueItem({ key: "unavailable-key" })
    player.playAtOffset.mockRejectedValueOnce(new UnavailableError("apple", track))

    const loop = new PlaybackLoop(player)
    loop.enableAutoplay()
    loop.start("station-1")

    await triggerQueueUpdate([track])

    expect(mockStationSocket.expireTrack).toHaveBeenCalledWith("unavailable-key", false)
    loop.stop()
  })
})

// ─── resume() ─────────────────────────────────────────────────────────────────

describe("resume()", () => {
  it("plays the pending track at a freshly-calculated offset", async () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    // autoplay NOT enabled — first queue update will block
    loop.start("station-1")

    const durationMs = 200_000
    const expirationTime = Date.now() + durationMs  // fresh, 0% elapsed
    const track = makeQueueItem({ key: "pending-key", expirationTime, durationMs })
    await triggerQueueUpdate([track])

    expect(player.playAtOffset).not.toHaveBeenCalled()

    // Now the user taps play
    await loop.resume()

    expect(player.playAtOffset).toHaveBeenCalledOnce()
    const [, offset] = player.playAtOffset.mock.calls[0] as [QueueItem, number]
    // offset ≈ 0 since we just set expirationTime = now + durationMs
    expect(offset).toBeGreaterThanOrEqual(0)
    expect(offset).toBeLessThan(5)
    loop.stop()
  })

  it("expires a track that has already ended by the time resume() is called", async () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    loop.start("station-1")

    const expiredTrack = makeQueueItem({
      key: "expired-key",
      expirationTime: Date.now() + 50,  // expires almost immediately
    })
    await triggerQueueUpdate([expiredTrack])

    // Wait for the track to expire
    await new Promise(r => setTimeout(r, 60))

    await loop.resume()

    expect(player.playAtOffset).not.toHaveBeenCalled()
    expect(mockStationSocket.expireTrack).toHaveBeenCalledWith("expired-key", true)
    loop.stop()
  })
})

// ─── setMuted ─────────────────────────────────────────────────────────────────

describe("setMuted", () => {
  it("calls player.setVolume(0) when muting", () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    loop.setMuted(true)
    expect(player.setVolume).toHaveBeenCalledWith(0)
  })

  it("calls player.setVolume(1) when unmuting", () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    loop.setMuted(false)
    expect(player.setVolume).toHaveBeenCalledWith(1)
  })

  it("fires onMutedChange with the new value", () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    const cb = vi.fn()
    loop.onMutedChange = cb
    loop.setMuted(true)
    expect(cb).toHaveBeenCalledWith(true)
  })
})

// ─── onNowPlayingChange callback ──────────────────────────────────────────────

describe("onNowPlayingChange callback", () => {
  it("fires with the new track on a hard switch", async () => {
    const player = createMockPlayer()
    const loop = new PlaybackLoop(player)
    loop.enableAutoplay()
    loop.start("station-1")

    const cb = vi.fn()
    loop.onNowPlayingChange = cb

    const track = makeQueueItem({ name: "New Track" })
    await triggerQueueUpdate([track])

    expect(cb).toHaveBeenCalledWith(expect.objectContaining({ name: "New Track" }))
    loop.stop()
  })
})
