/**
 * Tests for the client-side PartyKit service.
 *
 * Focuses on the migrateTrack utility, which normalises old catalogId-based
 * track shapes into the current platformIds shape.  StationSocket/IndexSocket
 * are not tested here because they require live PartySocket connections.
 */
import { describe, it, expect } from "vitest"
import { migrateTrack } from "../services/partykit"

describe("migrateTrack (client)", () => {
  it("returns a track unchanged if it already has platformIds", () => {
    const track = {
      platformIds: { apple: "1234567890" },
      isrc: "USAT21900001",
      name: "Modern Track",
      addedViaPlatform: "apple",
    }
    expect(migrateTrack(track)).toEqual(track)
  })

  it("migrates old catalogId → platformIds.apple", () => {
    const old = {
      catalogId: "9876543210",
      isrc: "USAT21900001",
      name: "Old Track",
      durationMs: 200000,
    }
    const result = migrateTrack(old) as any
    expect(result.platformIds).toEqual({ apple: "9876543210" })
    expect(result.addedViaPlatform).toBe("apple")
    // Client migrateTrack spreads the original object, so catalogId is still present.
    // The consumer should use platformIds.apple instead.
    expect(result.platformIds.apple).toBe("9876543210")
  })

  it("sets addedViaPlatform to 'apple' when not already present", () => {
    const old = { catalogId: "111", name: "Track" }
    const result = migrateTrack(old) as any
    expect(result.addedViaPlatform).toBe("apple")
  })

  it("preserves an existing addedViaPlatform value", () => {
    const old = { catalogId: "111", addedViaPlatform: "spotify", name: "Track" }
    const result = migrateTrack(old) as any
    expect(result.addedViaPlatform).toBe("spotify")
  })

  it("preserves isrc from old track shape", () => {
    const old = { catalogId: "111", isrc: "USAT001", name: "Track" }
    expect(migrateTrack(old as any).isrc).toBe("USAT001")
  })

  it("preserves all other track fields during migration", () => {
    const old = {
      catalogId: "111",
      isrc: "US001",
      name: "Song",
      artistName: "Artist",
      albumName: "Album",
      artworkUrl: "https://example.com/art.jpg",
      durationMs: 180000,
    }
    const result = migrateTrack(old) as any
    expect(result.name).toBe("Song")
    expect(result.artistName).toBe("Artist")
    expect(result.albumName).toBe("Album")
    expect(result.durationMs).toBe(180000)
  })
})
