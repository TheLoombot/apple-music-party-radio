import { getMusicUserToken, artworkUrl } from "./musickit"
import type { Track, SearchItem, LibraryPlaylistResult, PlaylistResult } from "../types"

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
    .filter((x): x is SearchItem => x !== null)

  const albums: SearchItem[] = (data.results?.albums?.data ?? []).map((item: any) => ({
    kind: "album" as const,
    id: item.id,
    name: item.attributes?.name ?? "",
    subtitle: item.attributes?.artistName ?? "",
    artworkUrl: item.attributes?.artwork?.url ?? ""
  }))

  const playlists: SearchItem[] = (data.results?.playlists?.data ?? []).map((item: any) => ({
    kind: "playlist" as const,
    id: item.id,
    name: item.attributes?.name ?? "",
    subtitle: item.attributes?.curatorName ?? item.attributes?.artistName ?? "",
    artworkUrl: item.attributes?.artwork?.url ?? ""
  }))

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
  return (data.data ?? []).map(normalizeTrack).filter((t): t is Track => t !== null)
}

export async function getPlaylistTracks(playlistId: string, storefront = "us"): Promise<Track[]> {
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/playlists/${playlistId}/tracks?limit=100`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.data ?? []).map(normalizeTrack).filter((t): t is Track => t !== null)
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
      results.push({
        kind: "library-playlist" as const,
        id: item.id,
        name: item.attributes?.name ?? "",
        subtitle: curator,
        artworkUrl: item.attributes?.artwork?.url ?? catalogAttrs?.artwork?.url ?? "",
        trackCount: item.attributes?.trackCount ?? catalogAttrs?.trackCount ?? undefined
      })
    }

    url = data.next ? `https://api.music.apple.com${data.next}` : ""
  }

  return results
}

export async function getLibraryPlaylistTracks(playlistId: string): Promise<Track[]> {
  const res = await fetch(
    `https://api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?limit=100`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  const tracks: (Track | null)[] = (data.data ?? []).map(normalizeLibraryTrack)
  return tracks.filter((t): t is Track => t !== null)
}

export async function getChartSongs(storefront = "us"): Promise<Track[]> {
  const params = new URLSearchParams({ types: "songs", chart: "most-played", limit: "20" })
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/charts?${params}`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.results?.songs?.[0]?.data ?? []).map(normalizeTrack).filter((t): t is Track => t !== null)
}

export async function getRecommendedPlaylists(): Promise<PlaylistResult[]> {
  const res = await fetch(
    "https://api.music.apple.com/v1/me/recommendations",
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()

  const seen = new Set<string>()
  const playlists: PlaylistResult[] = []

  for (const rec of data.data ?? []) {
    if (rec.attributes?.kind !== "music-recommendations") continue
    for (const item of rec.relationships?.contents?.data ?? []) {
      if (item.type !== "playlists" || seen.has(item.id)) continue
      seen.add(item.id)
      const a = item.attributes
      playlists.push({
        kind: "playlist",
        id: item.id,
        name: a?.name ?? "",
        subtitle: a?.curatorName ?? a?.description?.short ?? "",
        artworkUrl: a?.artwork?.url ?? "",
      })
    }
  }
  return playlists
}

export { artworkUrl }
