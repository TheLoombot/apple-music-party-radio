import { describe, expect, it } from "vitest"
import { migrateTrack, sameTrack } from "./track"

const base = {
  name: "Song",
  artistName: "Artist",
  albumName: "Album",
  artworkUrl: "",
  durationMs: 180_000,
}

describe("migrateTrack — every shape ever written must keep its Apple ID", () => {
  it("original catalogId shape", () => {
    const m = migrateTrack({ ...base, isrc: "USX1", catalogId: "111" }) as any
    expect(m.platformIds.apple).toBe("111")
    expect(m.catalogId).toBeUndefined()
    expect(m.isrc).toBe("USX1")
  })

  it("current platformIds shape", () => {
    const m = migrateTrack({ ...base, isrc: "USX1", platformIds: { apple: "222" }, addedViaPlatform: "apple" }) as any
    expect(m.platformIds.apple).toBe("222")
  })

  it("flattened appleId shape (ef1336d era)", () => {
    const m = migrateTrack({ ...base, isrc: "USX1", appleId: "333" }) as any
    expect(m.platformIds.apple).toBe("333")
    expect(m.appleId).toBeUndefined()
  })

  it("preserves a spotify id riding along in platformIds", () => {
    const m = migrateTrack({ ...base, isrc: "", platformIds: { apple: "4", spotify: "sp" } }) as any
    expect(m.platformIds).toEqual({ apple: "4", spotify: "sp" })
  })

  it("record with no ID at all passes through unstripped (no poison records)", () => {
    const m = migrateTrack({ ...base, isrc: "USX9" }) as any
    expect(m.isrc).toBe("USX9")
    expect(m.platformIds).toEqual({})
    expect(m.name).toBe("Song")
  })

  it("defaults missing isrc to empty string", () => {
    const m = migrateTrack({ ...base, catalogId: "5" }) as any
    expect(m.isrc).toBe("")
  })

  it("backfills pool fields on pool records of any shape", () => {
    const m = migrateTrack({ ...base, isrc: "USX1", appleId: "6", lastPlayedAt: 123 }) as any
    expect(m.lastPlayedAt).toBe(123)
    expect(m.addedByUsers).toEqual([])
    expect(m.playCount).toBe(1)
    expect(m.platformIds.apple).toBe("6")
  })

  it("does not invent pool fields on queue records", () => {
    const m = migrateTrack({ ...base, isrc: "USX1", catalogId: "7" }) as any
    expect("playCount" in m).toBe(false)
  })
})

describe("sameTrack", () => {
  it("matches on ISRC when both have one", () => {
    expect(sameTrack({ isrc: "A" }, { isrc: "A", platformIds: { apple: "9" } })).toBe(true)
  })

  it("never matches on empty ISRC", () => {
    expect(sameTrack({ isrc: "" }, { isrc: "" })).toBe(false)
  })

  it("falls back to apple id", () => {
    expect(sameTrack({ isrc: "", platformIds: { apple: "1" } }, { platformIds: { apple: "1" } })).toBe(true)
    expect(sameTrack({ platformIds: { apple: "1" } }, { platformIds: { apple: "2" } })).toBe(false)
  })

  it("no IDs in common → no match", () => {
    expect(sameTrack({ isrc: "A" }, { platformIds: { apple: "1" } })).toBe(false)
  })
})
