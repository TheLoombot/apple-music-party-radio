import { describe, expect, it } from "vitest"
import { parsePoolCsv, poolToCsv } from "./poolCsv"
import type { PoolTrack } from "../types"

function poolTrack(over: Partial<PoolTrack>): PoolTrack {
  return {
    isrc: "USX1",
    platformIds: { apple: "111" },
    addedViaPlatform: "apple",
    name: "Song",
    artistName: "Artist",
    albumName: "Album",
    artworkUrl: "https://x/{w}x{h}.jpg",
    durationMs: 200_000,
    lastPlayedAt: Date.parse("2026-06-09T12:00:00Z"),
    addedByUsers: ["u1"],
    playCount: 3,
    ...over,
  }
}

describe("poolToCsv → parsePoolCsv round-trip", () => {
  it("round-trips identity, stats, and names with commas/quotes", () => {
    const csv = poolToCsv([
      poolTrack({ name: 'Don\'t Stop, "Believing"', artistName: "Journey, Jr." }),
      poolTrack({ isrc: "USX2", platformIds: { apple: "222" }, name: "Plain" }),
    ])
    const rows = parsePoolCsv(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0].name).toBe('Don\'t Stop, "Believing"')
    expect(rows[0].artist).toBe("Journey, Jr.")
    expect(rows[0].isrc).toBe("USX1")
    expect(rows[0].appleId).toBe("111")
    expect(rows[0].durationMs).toBe(200_000)
    expect(rows[0].playCount).toBe(3)
    expect(new Date(rows[0].lastPlayedAt!).toISOString().slice(0, 10)).toBe("2026-06-09")
  })

  it("exports stranded tracks (no apple id) with their ISRC intact", () => {
    const rows = parsePoolCsv(poolToCsv([poolTrack({ platformIds: {} })]))
    expect(rows[0].appleId).toBe("")
    expect(rows[0].isrc).toBe("USX1")
  })

  it("exports addedByNames values as a joined added_by column", () => {
    const rows = parsePoolCsv(poolToCsv([poolTrack({ addedByNames: { u1: "Ana", u2: "Theo" } })]))
    expect(rows[0].addedBy).toBe("Ana; Theo")
  })
})

describe("parsePoolCsv — hand-edited and foreign files", () => {
  it("accepts a minimal hand-written file with only an isrc column", () => {
    const rows = parsePoolCsv("isrc\nUSX9\nUSY3\n")
    expect(rows).toHaveLength(2)
    expect(rows[0].isrc).toBe("USX9")
    expect(rows[1].appleId).toBe("")
  })

  it("matches columns by header name regardless of order, ignores unknown columns", () => {
    const rows = parsePoolCsv("rating,apple_id,name\n5,777,Some Song\n")
    expect(rows[0].appleId).toBe("777")
    expect(rows[0].name).toBe("Some Song")
  })

  it("strips a UTF-8 BOM and tolerates a missing trailing newline", () => {
    const rows = parsePoolCsv("﻿isrc,name\nUSX1,Last Row")
    expect(rows[0].isrc).toBe("USX1")
    expect(rows[0].name).toBe("Last Row")
  })

  it("skips fully blank lines", () => {
    expect(parsePoolCsv("isrc\n\nUSX1\n\n")).toHaveLength(1)
  })

  it("parses quoted fields with embedded newlines", () => {
    const rows = parsePoolCsv('isrc,name\nUSX1,"Line\nBreak"\n')
    expect(rows[0].name).toBe("Line\nBreak")
  })

  it("throws on a file with no id columns at all", () => {
    expect(() => parsePoolCsv("title,artist\nA,B\n")).toThrow(/isrc/)
  })

  it("treats malformed numerics and dates as absent", () => {
    const rows = parsePoolCsv("isrc,duration_ms,play_count,last_played\nUSX1,abc,-2,not-a-date\n")
    expect(rows[0].durationMs).toBeUndefined()
    expect(rows[0].playCount).toBeUndefined()
    expect(rows[0].lastPlayedAt).toBeUndefined()
  })
})
