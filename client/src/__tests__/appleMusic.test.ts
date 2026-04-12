/**
 * Tests for Apple Music API service.
 *
 * All network calls are intercepted with vi.stubGlobal("fetch", ...) so no
 * real network requests are made. Tests focus on:
 *  - normalizeTrack  (invoked through getAlbumTracks / getPlaylistTracks)
 *  - normalizeLibraryTrack  (invoked through getLibraryPlaylistTracks)
 *  - Catalog-ID-preference logic in getLibraryPlaylistTracks
 *  - searchCatalog interleaving algorithm
 *  - graceful fallback for non-OK responses
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  searchCatalog,
  getAlbumTracks,
  getPlaylistTracks,
  getLibraryPlaylistTracks,
  getUserStorefront,
} from "../services/appleMusic"

// appleMusic.ts calls getMusicUserToken() from musickit.ts at the module level
// (inside the `headers()` closure). Mock the entire musickit module so we
// never import MusicKit JS in the test environment.
vi.mock("../services/musickit", () => ({
  getMusicUserToken: () => "mock-user-token",
  artworkUrl: (template: string, size: number) =>
    template.replace("{w}", String(size * 2)).replace("{h}", String(size * 2)),
}))

function stubFetch(data: unknown, ok = true, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok,
      status,
      json: async () => data,
    }))
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ─── getUserStorefront ────────────────────────────────────────────────────────

describe("getUserStorefront", () => {
  it("returns the storefront ID from a successful response", async () => {
    stubFetch({ data: [{ id: "gb" }] })
    expect(await getUserStorefront()).toBe("gb")
  })

  it('falls back to "us" when the response is not OK', async () => {
    stubFetch({}, false, 401)
    expect(await getUserStorefront()).toBe("us")
  })

  it('falls back to "us" when the data array is empty', async () => {
    stubFetch({ data: [] })
    expect(await getUserStorefront()).toBe("us")
  })
})

// ─── getAlbumTracks — tests normalizeTrack ────────────────────────────────────

describe("getAlbumTracks / normalizeTrack", () => {
  it("normalizes a catalog song response into a Track", async () => {
    stubFetch({
      data: [{
        id: "1234567890",
        attributes: {
          isrc: "USAT21900001",
          name: "Test Song",
          artistName: "Test Artist",
          albumName: "Test Album",
          artwork: { url: "https://example.com/{w}x{h}bb.jpg" },
          durationInMillis: 210000,
        },
      }],
    })

    const tracks = await getAlbumTracks("album-id")
    expect(tracks).toHaveLength(1)
    const t = tracks[0]
    expect(t.platformIds.apple).toBe("1234567890")
    expect(t.isrc).toBe("USAT21900001")
    expect(t.name).toBe("Test Song")
    expect(t.artistName).toBe("Test Artist")
    expect(t.durationMs).toBe(210000)
    expect(t.addedViaPlatform).toBe("apple")
  })

  it("defaults isrc to empty string when missing from attributes", async () => {
    stubFetch({
      data: [{
        id: "999",
        attributes: { name: "No ISRC", artistName: "", albumName: "", durationInMillis: 180000 },
      }],
    })
    const tracks = await getAlbumTracks("album-id")
    expect(tracks[0].isrc).toBe("")
  })

  it("defaults durationMs to 0 when durationInMillis is missing", async () => {
    stubFetch({
      data: [{ id: "999", attributes: { name: "No Duration", artistName: "" } }],
    })
    const tracks = await getAlbumTracks("album-id")
    expect(tracks[0].durationMs).toBe(0)
  })

  it("filters out items with no attributes", async () => {
    stubFetch({ data: [{ id: "999" }, null] })
    const tracks = await getAlbumTracks("album-id")
    expect(tracks).toHaveLength(0)
  })

  it("returns [] when response is not OK", async () => {
    stubFetch({}, false, 404)
    expect(await getAlbumTracks("album-id")).toEqual([])
  })
})

// ─── getLibraryPlaylistTracks — catalog ID preference ─────────────────────────

describe("getLibraryPlaylistTracks", () => {
  it("prefers the catalog relationship ID over playParams.catalogId", async () => {
    stubFetch({
      data: [{
        id: "i.LibraryIdABC",
        attributes: {
          name: "Catalog Song",
          artistName: "Artist",
          albumName: "Album",
          durationInMillis: 200000,
          playParams: { catalogId: "wrong-catalog-id" },
        },
        relationships: {
          catalog: {
            data: [{
              id: "correct-catalog-id",
              attributes: {
                isrc: "USAT001",
                name: "Catalog Song",
                artistName: "Artist",
                albumName: "Album",
                artwork: { url: "https://example.com/{w}x{h}.jpg" },
                durationInMillis: 200000,
              },
            }],
          },
        },
      }],
    })

    const tracks = await getLibraryPlaylistTracks("playlist-id")
    expect(tracks).toHaveLength(1)
    // Must use the catalog relationship ID, NOT the library item.id or playParams.catalogId
    expect(tracks[0].platformIds.apple).toBe("correct-catalog-id")
  })

  it("falls back to playParams.catalogId when no catalog relationship", async () => {
    stubFetch({
      data: [{
        id: "i.LibraryIdXYZ",
        attributes: {
          name: "Purchase Song",
          artistName: "Artist",
          albumName: "Album",
          isrc: "US001",
          durationInMillis: 180000,
          playParams: { catalogId: "fallback-catalog-id" },
        },
        relationships: { catalog: { data: [] } },
      }],
    })

    const tracks = await getLibraryPlaylistTracks("playlist-id")
    expect(tracks).toHaveLength(1)
    expect(tracks[0].platformIds.apple).toBe("fallback-catalog-id")
  })

  it("returns track with empty platformIds for local-only/DRM-only tracks", async () => {
    stubFetch({
      data: [{
        id: "i.LocalTrack",
        attributes: {
          name: "Local File",
          artistName: "Me",
          albumName: "My Album",
          durationInMillis: 240000,
          // No playParams.catalogId, no catalog relationship
        },
        relationships: { catalog: { data: [] } },
      }],
    })

    const tracks = await getLibraryPlaylistTracks("playlist-id")
    expect(tracks).toHaveLength(1)
    // Track is returned but has no playable platform ID
    expect(tracks[0].platformIds).toEqual({})
    expect(tracks[0].name).toBe("Local File")
  })

  it("returns [] when response is not OK", async () => {
    stubFetch({}, false, 403)
    expect(await getLibraryPlaylistTracks("playlist-id")).toEqual([])
  })
})

// ─── searchCatalog — interleaving algorithm ───────────────────────────────────

describe("searchCatalog", () => {
  it("returns [] for blank/whitespace queries", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    expect(await searchCatalog("   ")).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("interleaves songs and containers (albums/playlists)", async () => {
    stubFetch({
      results: {
        songs: {
          data: [
            { id: "s1", attributes: { name: "Song 1", artistName: "A1", durationInMillis: 200000, isrc: "IS01" } },
            { id: "s2", attributes: { name: "Song 2", artistName: "A2", durationInMillis: 210000, isrc: "IS02" } },
          ],
        },
        albums: {
          data: [
            { id: "al1", attributes: { name: "Album 1", artistName: "AA", artwork: { url: "" }, releaseDate: "2020-01-01" } },
          ],
        },
        playlists: {
          data: [
            { id: "pl1", attributes: { name: "Playlist 1", curatorName: "Editor", artwork: { url: "" }, lastModifiedDate: "2023-06-01T00:00:00Z" } },
          ],
        },
      },
    })

    const results = await searchCatalog("test")
    // Expected order: song1, album1, song2, playlist1 (interleaved)
    expect(results[0]).toMatchObject({ kind: "song" })
    expect(results[1]).toMatchObject({ kind: "album" })
    expect(results[2]).toMatchObject({ kind: "song" })
    expect(results[3]).toMatchObject({ kind: "playlist" })
  })

  it("songs without attributes are filtered out", async () => {
    stubFetch({
      results: {
        songs: { data: [{ id: "bad" }] },
        albums: { data: [] },
        playlists: { data: [] },
      },
    })

    const results = await searchCatalog("test")
    expect(results.filter(r => r.kind === "song")).toHaveLength(0)
  })

  it("returns [] when response is not OK", async () => {
    stubFetch({}, false, 500)
    expect(await searchCatalog("hello")).toEqual([])
  })
})

// ─── getPlaylistTracks ────────────────────────────────────────────────────────

describe("getPlaylistTracks", () => {
  it("normalizes catalog playlist tracks correctly", async () => {
    stubFetch({
      data: [{
        id: "pl-track-1",
        attributes: {
          name: "Playlist Track",
          artistName: "Someone",
          albumName: "Playlist",
          isrc: "PL001",
          artwork: { url: "https://example.com/{w}x{h}.jpg" },
          durationInMillis: 195000,
        },
      }],
    })

    const tracks = await getPlaylistTracks("pl-id")
    expect(tracks).toHaveLength(1)
    expect(tracks[0].platformIds.apple).toBe("pl-track-1")
    expect(tracks[0].name).toBe("Playlist Track")
  })
})
