import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  sameTrack,
  liveUntilFromQueue,
  migrateTrack,
  hasAnyPlatformId,
  LIVE_UNTIL_GRACE_MS,
} from "../utils"
import type { QueueItem } from "../utils"

// ─── sameTrack ────────────────────────────────────────────────────────────────

describe("sameTrack", () => {
  it("matches when both tracks have the same ISRC", () => {
    const a = { isrc: "USAT21900001", platformIds: {} }
    const b = { isrc: "USAT21900001", platformIds: {} }
    expect(sameTrack(a, b)).toBe(true)
  })

  it("does not match when ISRCs differ", () => {
    const a = { isrc: "USAT21900001", platformIds: {} }
    const b = { isrc: "USAT21900002", platformIds: {} }
    expect(sameTrack(a, b)).toBe(false)
  })

  it("never matches on empty ISRC — the empty-ISRC pool collapse bug", () => {
    // This was a real bug: all ISRC-less tracks collapsed into one pool entry.
    // Verify the fix: empty string must not count as a match.
    const a = { isrc: "", platformIds: {} }
    const b = { isrc: "", platformIds: {} }
    expect(sameTrack(a, b)).toBe(false)
  })

  it("falls through to Apple ID when one track has no ISRC", () => {
    const a = { isrc: "", platformIds: { apple: "1234567890" } }
    const b = { isrc: "", platformIds: { apple: "1234567890" } }
    expect(sameTrack(a, b)).toBe(true)
  })

  it("falls through to Apple ID when both ISRCs are absent", () => {
    const a = { isrc: "", platformIds: { apple: "111" } }
    const b = { isrc: "", platformIds: { apple: "222" } }
    expect(sameTrack(a, b)).toBe(false)
  })

  it("ISRC match takes precedence over Apple ID mismatch", () => {
    // Same ISRC but different catalog IDs (e.g. different storefronts)
    const a = { isrc: "USAT21900001", platformIds: { apple: "111" } }
    const b = { isrc: "USAT21900001", platformIds: { apple: "999" } }
    expect(sameTrack(a, b)).toBe(true)
  })

  it("falls through to Spotify ID when neither has ISRC or Apple ID", () => {
    const a = { isrc: "", platformIds: { spotify: "sp123" } }
    const b = { isrc: "", platformIds: { spotify: "sp123" } }
    expect(sameTrack(a, b)).toBe(true)
  })

  it("returns false when no IDs overlap", () => {
    const a = { isrc: "", platformIds: { apple: "ap1" } }
    const b = { isrc: "", platformIds: { spotify: "sp1" } }
    expect(sameTrack(a, b)).toBe(false)
  })

  it("returns false when both platformIds are empty", () => {
    const a = { isrc: "", platformIds: {} }
    const b = { isrc: "", platformIds: {} }
    expect(sameTrack(a, b)).toBe(false)
  })
})

// ─── liveUntilFromQueue ───────────────────────────────────────────────────────

describe("liveUntilFromQueue", () => {
  it("returns 0 for an empty queue", () => {
    expect(liveUntilFromQueue([])).toBe(0)
  })

  it("returns queue[0].expirationTime + grace for a future expiry", () => {
    const futureExpiry = Date.now() + 120_000
    const queue = [{ expirationTime: futureExpiry }] as QueueItem[]
    expect(liveUntilFromQueue(queue)).toBe(futureExpiry + LIVE_UNTIL_GRACE_MS)
  })

  it("uses max(expiry, now) for a stale expiry — DO wake-up scenario", () => {
    // The DO may have been hibernating; queue[0] has an expiry in the past.
    // liveUntilFromQueue must still return a future timestamp.
    const pastExpiry = Date.now() - 30_000
    const queue = [{ expirationTime: pastExpiry }] as QueueItem[]
    const result = liveUntilFromQueue(queue)
    // Should be at least now + LIVE_UNTIL_GRACE_MS (not pastExpiry + grace)
    expect(result).toBeGreaterThanOrEqual(Date.now() + LIVE_UNTIL_GRACE_MS - 50)
  })

  it("only uses queue[0], not the last track", () => {
    // Using the last robot track's expiry would inflate liveUntil by 30+ minutes.
    const now = Date.now()
    const queue = [
      { expirationTime: now + 60_000 },
      { expirationTime: now + 300_000 },
      { expirationTime: now + 2_000_000 },
    ] as QueueItem[]
    expect(liveUntilFromQueue(queue)).toBe(now + 60_000 + LIVE_UNTIL_GRACE_MS)
  })
})

// ─── migrateTrack ─────────────────────────────────────────────────────────────

describe("migrateTrack (server)", () => {
  it("passes through a track that already has platformIds", () => {
    const track = { platformIds: { apple: "123" }, isrc: "US123", name: "Test Song" }
    expect(migrateTrack(track)).toEqual(track)
  })

  it("migrates old catalogId shape → platformIds.apple", () => {
    const old = { catalogId: "987654321", isrc: "US123", name: "Old Song", durationMs: 200000 }
    const result = migrateTrack(old)
    expect(result.platformIds).toEqual({ apple: "987654321" })
    expect(result.addedViaPlatform).toBe("apple")
    expect(result.isrc).toBe("US123")
    expect("catalogId" in result).toBe(false)
  })

  it("provides empty isrc when original track lacked one", () => {
    const old = { catalogId: "111", name: "No ISRC" }
    expect(migrateTrack(old).isrc).toBe("")
  })

  it("backfills addedByUsers=[] for old pool tracks missing the field", () => {
    const poolTrack = { platformIds: { apple: "123" }, lastPlayedAt: 1000, playCount: 3 }
    expect(migrateTrack(poolTrack).addedByUsers).toEqual([])
  })

  it("backfills playCount=1 for old pool tracks missing the field", () => {
    const poolTrack = { platformIds: { apple: "123" }, lastPlayedAt: 1000 }
    expect(migrateTrack(poolTrack).playCount).toBe(1)
  })

  it("preserves existing addedByUsers on pool tracks", () => {
    const poolTrack = {
      platformIds: { apple: "123" },
      lastPlayedAt: 1000,
      addedByUsers: ["user-a", "user-b"],
      playCount: 2,
    }
    expect(migrateTrack(poolTrack).addedByUsers).toEqual(["user-a", "user-b"])
  })
})

// ─── hasAnyPlatformId ─────────────────────────────────────────────────────────

describe("hasAnyPlatformId", () => {
  it("returns true when an Apple ID is present", () => {
    expect(hasAnyPlatformId({ platformIds: { apple: "123" } })).toBe(true)
  })

  it("returns true when a Spotify ID is present", () => {
    expect(hasAnyPlatformId({ platformIds: { spotify: "sp-abc" } })).toBe(true)
  })

  it("returns true when both IDs are present", () => {
    expect(hasAnyPlatformId({ platformIds: { apple: "123", spotify: "sp-abc" } })).toBe(true)
  })

  it("returns false for empty platformIds", () => {
    expect(hasAnyPlatformId({ platformIds: {} })).toBe(false)
  })

  it("returns false for undefined platform values", () => {
    expect(hasAnyPlatformId({ platformIds: { apple: undefined, spotify: undefined } })).toBe(false)
  })
})
