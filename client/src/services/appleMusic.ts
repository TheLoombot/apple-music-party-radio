import { getMusicUserToken, artworkUrl } from "./musickit"
import type { Track, SearchItem, LibraryPlaylistResult, PlaylistResult, AlbumResult } from "../types"

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${import.meta.env.VITE_APPLE_DEVELOPER_TOKEN as string}`,
    "Music-User-Token": getMusicUserToken()
  }
}

function normalizeTrack(item: any): Track | null {
  if (!item?.attributes) return null
  const a = item.attributes
  return {
    isrc: a.isrc ?? "",
    platformIds: { apple: item.id },
    addedViaPlatform: "apple",
    name: a.name ?? "",
    artistName: a.artistName ?? "",
    albumName: a.albumName ?? "",
    artworkUrl: a.artwork?.url ?? "",
    durationMs: a.durationInMillis ?? 0
  }
}

export async function getUserStorefront(): Promise<string> {
  const res = await fetch("https://api.music.apple.com/v1/me/storefront", { headers: headers() })
  if (!res.ok) return "us"
  const data = await res.json()
  return data.data?.[0]?.id ?? "us"
}

export async function searchCatalog(term: string, storefront = "us"): Promise<SearchItem[]> {
  if (!term.trim()) return []
  const params = new URLSearchParams({ term, types: "songs,albums,playlists", limit: "8" })
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/search?${params}`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()

  const songs: SearchItem[] = (data.results?.songs?.data ?? [])
    .map((item: any) => { const t = normalizeTrack(item); return t ? { kind: "song" as const, track: t } : null })
    .filter((x: SearchItem | null): x is SearchItem => x !== null)

  const albums: SearchItem[] = (data.results?.albums?.data ?? []).map((item: any) => {
    const rd: string | undefined = item.attributes?.releaseDate
    return {
      kind: "album" as const,
      id: item.id,
      name: item.attributes?.name ?? "",
      subtitle: item.attributes?.artistName ?? "",
      artworkUrl: item.attributes?.artwork?.url ?? "",
      releaseYear: rd ? new Date(rd).getFullYear() : undefined,
    }
  })

  const playlists: SearchItem[] = (data.results?.playlists?.data ?? []).map((item: any) => {
    const lmd: string | undefined = item.attributes?.lastModifiedDate
    return {
      kind: "playlist" as const,
      id: item.id,
      name: item.attributes?.name ?? "",
      subtitle: item.attributes?.curatorName ?? item.attributes?.artistName ?? "",
      artworkUrl: item.attributes?.artwork?.url ?? "",
      lastModifiedAt: lmd ? new Date(lmd).getTime() : undefined,
    }
  })

  // Interleave songs first, then albums and playlists together
  const containers = albums.flatMap((a, i) => playlists[i] ? [a, playlists[i]] : [a])
    .concat(playlists.slice(albums.length))
  const results: SearchItem[] = []
  const maxLen = Math.max(songs.length, containers.length)
  for (let i = 0; i < maxLen; i++) {
    if (i < songs.length) results.push(songs[i])
    if (i < containers.length) results.push(containers[i])
  }
  return results
}

export async function getAlbumTracks(albumId: string, storefront = "us"): Promise<Track[]> {
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/albums/${albumId}/tracks?limit=30`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.data ?? []).map(normalizeTrack).filter((t: Track | null): t is Track => t !== null)
}

export async function getPlaylistTracks(playlistId: string, storefront = "us"): Promise<Track[]> {
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/playlists/${playlistId}/tracks?limit=100`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.data ?? []).map(normalizeTrack).filter((t: Track | null): t is Track => t !== null)
}

// Library tracks use playParams.catalogId, not item.id
// Returns null for tracks without a catalog ID (local files, DRM-only purchases)
// — those can't be played via setQueue({ song: catalogId }) and must be skipped.
function normalizeLibraryTrack(item: any): Track | null {
  const a = item.attributes
  const catalogId = a.playParams?.catalogId
  if (!catalogId) return null
  return {
    isrc: a.isrc ?? "",
    platformIds: { apple: catalogId },
    addedViaPlatform: "apple",
    name: a.name,
    artistName: a.artistName ?? "",
    albumName: a.albumName ?? "",
    artworkUrl: a.artwork?.url ?? "",
    durationMs: a.durationInMillis ?? 0
  }
}

export async function getLibraryPlaylists(): Promise<LibraryPlaylistResult[]> {
  const results: LibraryPlaylistResult[] = []
  let url = "https://api.music.apple.com/v1/me/library/playlists?limit=100&include=catalog"

  while (url) {
    const res = await fetch(url, { headers: headers() })
    if (!res.ok) break
    const data = await res.json()

    for (const item of data.data ?? []) {
      const catalogAttrs = item.relationships?.catalog?.data?.[0]?.attributes
      const curator = catalogAttrs?.curatorName ?? item.attributes?.description?.standard ?? ""
      const lmd: string | undefined = catalogAttrs?.lastModifiedDate ?? item.attributes?.lastModifiedDate
      results.push({
        kind: "library-playlist" as const,
        id: item.id,
        name: item.attributes?.name ?? "",
        subtitle: curator,
        artworkUrl: item.attributes?.artwork?.url ?? catalogAttrs?.artwork?.url ?? "",
        trackCount: item.attributes?.trackCount ?? catalogAttrs?.trackCount ?? undefined,
        lastModifiedAt: lmd ? new Date(lmd).getTime() : undefined,
      })
    }

    url = data.next ? `https://api.music.apple.com${data.next}` : ""
  }

  return results
}

export async function getLibraryPlaylistTracks(playlistId: string): Promise<Track[]> {
  const res = await fetch(
    `https://api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?limit=100&include=catalog`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.data ?? []).map((item: any): Track => {
    // Prefer catalog relationship — gives the correct storefront-specific catalog ID.
    const catalogItem = item.relationships?.catalog?.data?.[0]
    if (catalogItem) return normalizeTrack(catalogItem)!
    // Fall back to playParams.catalogId for purchased tracks not in the catalog.
    const available = normalizeLibraryTrack(item)
    if (available) return available
    // No playable ID at all (local file, DRM-only) — return with empty platformIds
    // so the UI can display it as unavailable rather than hiding it entirely.
    const a = item.attributes ?? {}
    return {
      isrc: a.isrc ?? "",
      platformIds: {},
      addedViaPlatform: "apple",
      name: a.name ?? "",
      artistName: a.artistName ?? "",
      albumName: a.albumName ?? "",
      artworkUrl: a.artwork?.url ?? "",
      durationMs: a.durationInMillis ?? 0,
    }
  })
}

export interface ChartResult {
  id: string
  name: string
  tracks: Track[]
}

export async function getCharts(storefront = "us"): Promise<ChartResult[]> {
  const params = new URLSearchParams({ types: "songs", limit: "20" })
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/charts?${params}`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.results?.songs ?? []).map((chart: any) => ({
    id: chart.chart as string,
    name: chart.name as string,
    tracks: (chart.data ?? []).map(normalizeTrack).filter((t: Track | null): t is Track => t !== null)
  }))
}

export async function getRelatedPlaylistsForSong(songId: string, storefront = "us"): Promise<PlaylistResult[]> {
  // Step 1: resolve album ID from song
  const songRes = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/songs/${songId}?include=albums`,
    { headers: headers() }
  )
  if (!songRes.ok) return []
  const songData = await songRes.json()
  const albumId = songData.data?.[0]?.relationships?.albums?.data?.[0]?.id
  if (!albumId) return []

  // Step 2: fetch the "appears-on" view — playlists this album is featured on
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/albums/${albumId}?views=appears-on`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.data?.[0]?.views?.["appears-on"]?.data ?? []).map((item: any) => {
    const lmd: string | undefined = item.attributes?.lastModifiedDate
    return {
      kind: "playlist" as const,
      id: item.id,
      name: item.attributes?.name ?? "",
      subtitle: item.attributes?.curatorName ?? "",
      artworkUrl: item.attributes?.artwork?.url ?? "",
      lastModifiedAt: lmd ? new Date(lmd).getTime() : undefined,
    }
  })
}

export async function getAlbumForSong(songId: string, storefront = "us"): Promise<AlbumResult | null> {
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/songs/${songId}?include=albums`,
    { headers: headers() }
  )
  if (!res.ok) return null
  const data = await res.json()
  const album = data.data?.[0]?.relationships?.albums?.data?.[0]
  if (!album) return null
  const releaseDate: string | undefined = album.attributes?.releaseDate
  return {
    kind: "album",
    id: album.id,
    name: album.attributes?.name ?? "",
    subtitle: album.attributes?.artistName ?? "",
    artworkUrl: album.attributes?.artwork?.url ?? "",
    releaseYear: releaseDate ? new Date(releaseDate).getFullYear() : undefined,
  }
}

export async function getRecommendedPlaylists(): Promise<(PlaylistResult | AlbumResult)[]> {
  const res = await fetch(
    "https://api.music.apple.com/v1/me/recommendations",
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()

  const seen = new Set<string>()
  const results: (PlaylistResult | AlbumResult)[] = []

  for (const rec of data.data ?? []) {
    if (rec.attributes?.kind !== "music-recommendations") continue
    for (const item of rec.relationships?.contents?.data ?? []) {
      if (!["playlists", "albums"].includes(item.type) || seen.has(item.id)) continue
      seen.add(item.id)
      const a = item.attributes
      if (item.type === "albums") {
        const rd: string | undefined = a?.releaseDate
        results.push({
          kind: "album",
          id: item.id,
          name: a?.name ?? "",
          subtitle: a?.artistName ?? "",
          artworkUrl: a?.artwork?.url ?? "",
          releaseYear: rd ? new Date(rd).getFullYear() : undefined,
        })
      } else {
        const plmd: string | undefined = a?.lastModifiedDate
        results.push({
          kind: "playlist",
          id: item.id,
          name: a?.name ?? "",
          subtitle: a?.curatorName ?? a?.description?.short ?? "",
          artworkUrl: a?.artwork?.url ?? "",
          lastModifiedAt: plmd ? new Date(plmd).getTime() : undefined,
        })
      }
    }
  }
  return results
}

export interface AlbumEditorialInfo {
  notes?: string    // editorial/description text
  bgColor?: string  // hex without #, e.g. "1a1a2e"
  textColor1?: string
}

export async function getAlbumEditorial(albumId: string, storefront = "us"): Promise<AlbumEditorialInfo> {
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/albums/${albumId}`,
    { headers: headers() }
  )
  if (!res.ok) return {}
  const data = await res.json()
  const attrs = data.data?.[0]?.attributes
  if (!attrs) return {}
  const raw = attrs.editorialNotes?.standard ?? attrs.editorialNotes?.short
  return {
    notes: raw ? raw.replace(/<[^>]+>/g, "").trim() : undefined,
    bgColor: attrs.artwork?.bgColor,
    textColor1: attrs.artwork?.textColor1,
  }
}

export async function getPlaylistEditorial(playlistId: string, storefront = "us"): Promise<AlbumEditorialInfo> {
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/playlists/${playlistId}`,
    { headers: headers() }
  )
  if (!res.ok) return {}
  const data = await res.json()
  const attrs = data.data?.[0]?.attributes
  if (!attrs) return {}
  const raw = attrs.description?.standard ?? attrs.description?.short
    ?? attrs.editorialNotes?.standard ?? attrs.editorialNotes?.short
  return {
    notes: raw ? raw.replace(/<[^>]+>/g, "").trim() : undefined,
    bgColor: attrs.artwork?.bgColor,
    textColor1: attrs.artwork?.textColor1,
  }
}

export { artworkUrl }
