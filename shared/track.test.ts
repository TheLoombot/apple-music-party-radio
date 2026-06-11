import { describe, expect, it } from "vitest"
import { migrateTrack, sameTrack, trackKey } from "./track"

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
    expect(m.appleId).toBe("111")
    expect(m.catalogId).toBeUndefined()
    expect(m.isrc).toBe("USX1")
  })

  it("mid platformIds shape", () => {
    const m = migrateTrack({ ...base, isrc: "USX1", platformIds: { apple: "222" }, addedViaPlatform: "apple" }) as any
    expect(m.appleId).toBe("222")
    expect(m.platformIds).toBeUndefined()
    expect(m.addedViaPlatform).toBeUndefined()
  })

  it("current appleId shape passes through", () => {
    const m = migrateTrack({ ...base, isrc: "USX1", appleId: "333" }) as any
    expect(m.appleId).toBe("333")
  })

  it("drops a dormant spotify id (no other services supported)", () => {
    const m = migrateTrack({ ...base, isrc: "USX1", platformIds: { apple: "4", spotify: "sp" } }) as any
    expect(m.appleId).toBe("4")
    expect(m.platformIds).toBeUndefined()
  })

  it("record with no ID at all passes through unstripped (no poison records)", () => {
    const m = migrateTrack({ ...base, isrc: "USX9" }) as any
    expect(m.isrc).toBe("USX9")
    expect(m.appleId).toBeUndefined()
    expect(m.name).toBe("Song")
  })

  it("defaults missing isrc to empty string", () => {
    const m = migrateTrack({ ...base, catalogId: "5" }) as any
    expect(m.isrc).toBe("")
  })

  it("backfills pool fields on pool records of any shape", () => {
    const m = migrateTrack({ ...base, isrc: "USX1", platformIds: { apple: "6" }, lastPlayedAt: 123 }) as any
    expect(m.lastPlayedAt).toBe(123)
    expect(m.addedByUsers).toEqual([])
    expect(m.playCount).toBe(1)
    expect(m.appleId).toBe("6")
  })

  it("does not invent pool fields on queue records", () => {
    const m = migrateTrack({ ...base, isrc: "USX1", catalogId: "7" }) as any
    expect("playCount" in m).toBe(false)
  })
})

describe("sameTrack", () => {
  it("matches on ISRC when both have one", () => {
    expect(sameTrack({ isrc: "A" }, { isrc: "A", appleId: "9" })).toBe(true)
  })

  it("never matches on empty ISRC", () => {
    expect(sameTrack({ isrc: "" }, { isrc: "" })).toBe(false)
  })

  it("falls back to apple id", () => {
    expect(sameTrack({ isrc: "", appleId: "1" }, { appleId: "1" })).toBe(true)
    expect(sameTrack({ appleId: "1" }, { appleId: "2" })).toBe(false)
  })

  it("no IDs in common → no match", () => {
    expect(sameTrack({ isrc: "A" }, { appleId: "1" })).toBe(false)
  })
})

describe("trackKey", () => {
  it("prefers ISRC over apple id", () => {
    expect(trackKey({ isrc: "USX1", appleId: "1" })).toBe("isrc:USX1")
  })

  it("falls back to apple id, null when identity-less", () => {
    expect(trackKey({ isrc: "", appleId: "1" })).toBe("apple:1")
    expect(trackKey({ isrc: "" })).toBeNull()
  })
})
