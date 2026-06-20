import { getMusicUserToken, artworkUrl } from "./musickit"
import { log } from "./log"
import { sameTrack } from "../../../shared/track"
import type { Track, SearchItem, LibraryPlaylistResult, LibraryAlbumResult, PlaylistResult, AlbumResult } from "../types"

function headers(): HeadersInit {
  return {
    Authorization: `Bearer ${import.meta.env.VITE_APPLE_DEVELOPER_TOKEN as string}`,
    "Music-User-Token": getMusicUserToken()
  }
}

function normalizeTrack(item: any): Track | null {
  if (!item?.attributes) return null
  const a = item.attributes
  // playParams absent = not streamable in this storefront
  let streamable = !!a.playParams
  // offers present = Apple explicitly tells us what access types are available.
  // If offers is returned but contains no streaming/plus entry, the track is
  // catalog-present (hence has playParams) but purchase-only or region-locked.
  if (streamable && Array.isArray(a.offers)) {
    streamable = a.offers.some((o: any) => o.type === "streaming" || o.type === "plus")
  }
  return {
    isrc: a.isrc ?? "",
    ...(streamable ? { appleId: item.id as string } : {}),
    name: a.name ?? "",
    artistName: a.artistName ?? "",
    albumName: a.albumName ?? "",
    artworkUrl: a.artwork?.url ?? "",
    durationMs: a.durationInMillis ?? 0,
    ...(a.previews?.[0]?.url ? { previewUrl: a.previews[0].url as string } : {}),
  }
}

export async function getUserStorefront(): Promise<string> {
  const res = await fetch("https://api.music.apple.com/v1/me/storefront", { headers: headers() })
  if (!res.ok) return "us"
  const data = await res.json()
  return data.data?.[0]?.id ?? "us"
}

/** Batch-fetch catalog songs by ID (pool import resolution). Chunked under
 *  Apple's per-request fetch limit; unknown/dead IDs are silently absent from
 *  the result. */
export async function getSongsByIds(ids: string[], storefront = "us"): Promise<Track[]> {
  const out: Track[] = []
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const params = new URLSearchParams({ ids: chunk.join(","), extend: "offers" })
    const res = await fetch(`https://api.music.apple.com/v1/catalog/${storefront}/songs?${params}`, { headers: headers() })
    if (!res.ok) continue
    const data = await res.json()
    for (const item of data.data ?? []) {
      const t = normalizeTrack(item)
      if (t) out.push(t)
    }
  }
  return out
}

/** Batch-fetch catalog songs by ISRC (pool import healing — re-resolves tracks
 *  whose Apple ID is missing or dead). Apple caps filter[isrc] at 25 values. */
export async function getSongsByIsrcs(isrcs: string[], storefront = "us"): Promise<Track[]> {
  const out: Track[] = []
  for (let i = 0; i < isrcs.length; i += 25) {
    const chunk = isrcs.slice(i, i + 25)
    const params = new URLSearchParams({ "filter[isrc]": chunk.join(","), extend: "offers" })
    const res = await fetch(`https://api.music.apple.com/v1/catalog/${storefront}/songs?${params}`, { headers: headers() })
    if (!res.ok) continue
    const data = await res.json()
    for (const item of data.data ?? []) {
      const t = normalizeTrack(item)
      if (t) out.push(t)
    }
  }
  return out
}

export const SEARCH_PAGE_SIZE = 10

export interface SearchPage {
  items: SearchItem[]
  hasMore: boolean
}

export async function searchCatalog(term: string, storefront = "us", offset = 0): Promise<SearchPage> {
  if (!term.trim()) return { items: [], hasMore: false }
  const params = new URLSearchParams({
    term,
    types: "songs,albums,playlists",
    limit: String(SEARCH_PAGE_SIZE),
    offset: String(offset),
    extend: "offers",
  })
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/search?${params}`,
    { headers: headers() }
  )
  if (!res.ok) return { items: [], hasMore: false }
  const data = await res.json()

  type SongItem = { kind: "song"; track: Track }
  const songs: SongItem[] = (data.results?.songs?.data ?? [])
    .map((item: any): SongItem | null => { const t = normalizeTrack(item); return t ? { kind: "song", track: t } : null })
    .filter((x: SongItem | null): x is SongItem => x !== null && !!x.track.appleId)

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
      description: item.attributes?.description?.short ?? item.attributes?.description?.standard ?? "",
    }
  })

  // Interleave songs first, then albums and playlists together
  const containers = albums.flatMap((a, i) => playlists[i] ? [a, playlists[i]] : [a])
    .concat(playlists.slice(albums.length))
  const items: SearchItem[] = []
  const maxLen = Math.max(songs.length, containers.length)
  for (let i = 0; i < maxLen; i++) {
    if (i < songs.length) items.push(songs[i])
    if (i < containers.length) items.push(containers[i])
  }

  // Apple's response includes a `next` cursor per result type when more
  // pages exist for that type. If any type still has more, there's more
  // to load overall.
  const hasMore = !!(
    data.results?.songs?.next ||
    data.results?.albums?.next ||
    data.results?.playlists?.next
  )

  return { items, hasMore }
}

export async function getAlbumTracks(albumId: string, storefront = "us"): Promise<Track[]> {
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/albums/${albumId}/tracks?limit=30&extend=offers`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.data ?? []).map(normalizeTrack).filter((t: Track | null): t is Track => t !== null)
}

export async function getPlaylistTracks(playlistId: string, storefront = "us"): Promise<Track[]> {
  const res = await fetch(
    `https://api.music.apple.com/v1/catalog/${storefront}/playlists/${playlistId}/tracks?limit=100&extend=offers`,
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
    appleId: catalogId,
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
      // Curator only — the description now has its own line in PlaylistRow,
      // so falling back to it here would render the same text twice.
      const curator = catalogAttrs?.curatorName ?? ""
      const lmd: string | undefined = catalogAttrs?.lastModifiedDate ?? item.attributes?.lastModifiedDate
      results.push({
        kind: "library-playlist" as const,
        id: item.id,
        name: item.attributes?.name ?? "",
        subtitle: curator,
        artworkUrl: item.attributes?.artwork?.url ?? catalogAttrs?.artwork?.url ?? "",
        trackCount: item.attributes?.trackCount ?? catalogAttrs?.trackCount ?? undefined,
        lastModifiedAt: lmd ? new Date(lmd).getTime() : undefined,
        description: item.attributes?.description?.standard ?? catalogAttrs?.description?.standard ?? "",
        catalogId: item.relationships?.catalog?.data?.[0]?.id ?? undefined,
      })
    }

    url = data.next ? `https://api.music.apple.com${data.next}` : ""
  }

  return results
}

// ─── Identity playlist (DJ profile portability + saved tracks) ───────────────
//
// The user's iCloud Music Library doubles as cross-device storage for their
// hat.fm uid: a private library playlist carries the uid in its description,
// and iCloud sync makes it appear on every device they use. Attributes are
// write-once by necessity — the public Apple Music API cannot edit or delete
// library playlists — which is fine because the uid is immutable. Tracks CAN
// be appended though, and the same playlist collects everything the user
// saves from stations (the save-to-library button), so it earns its place in
// their library instead of sitting there as a mystery artifact.

const IDENTITY_PLAYLIST_NAME = "hat.fm"
const IDENTITY_MARKER = "ampr:v1:"

// Session caches for the save-to-library feature. The playlist's library id
// is discovered as a side effect of the boot-time findIdentityUid() call (or
// of creating the playlist); the contents snapshot loads lazily, once, the
// first time a saved-state check or a save needs it.
let identityPlaylistId: string | null = null
let identityCreateOp: Promise<string | null> | null = null
let identitySavedTracks: Track[] | null = null
let identitySavedTracksOp: Promise<Track[] | null> | null = null

function parseIdentityMarker(description: string | undefined): string | null {
  const m = (description ?? "").match(/ampr:v1:([0-9a-fA-F-]{16,})/)
  return m ? m[1] : null
}

/** True for the auto-created hat.fm identity playlist. The description marker
 *  is authoritative (survives renames); the name is a fallback for the rare
 *  case where the marker didn't come back on a library list. */
export function isIdentityPlaylist(pl: { name?: string; description?: string }): boolean {
  return parseIdentityMarker(pl.description) !== null || pl.name === IDENTITY_PLAYLIST_NAME
}

/** Recover the uid from the user's identity playlist, or null if none exists.
 *  Cheap library search by name first; if that misses (e.g. the user renamed
 *  the playlist in the Music app), fall back to scanning all library playlists
 *  for the description marker before giving up. Multiple matches (two fresh
 *  devices racing) tie-break on earliest dateAdded so every device converges
 *  on the same uid. Side effect: caches the winning playlist's library id for
 *  the save-to-library feature. */
export async function findIdentityUid(): Promise<string | null> {
  const candidates: { uid: string; playlistId: string; dateAdded: string }[] = []

  try {
    const params = new URLSearchParams({ term: IDENTITY_PLAYLIST_NAME, types: "library-playlists", limit: "25" })
    const res = await fetch(`https://api.music.apple.com/v1/me/library/search?${params}`, { headers: headers() })
    if (res.ok) {
      const data = await res.json()
      for (const item of data.results?.["library-playlists"]?.data ?? []) {
        // Search results may omit the description — fetch the full record when needed.
        let attrs = item.attributes
        if (!attrs?.description) {
          const detail = await fetch(`https://api.music.apple.com/v1/me/library/playlists/${item.id}`, { headers: headers() })
          if (detail.ok) attrs = (await detail.json()).data?.[0]?.attributes
        }
        const uid = parseIdentityMarker(attrs?.description?.standard)
        if (uid) candidates.push({ uid, playlistId: item.id, dateAdded: attrs?.dateAdded ?? "" })
      }
    }
  } catch (e) {
    log.net.warn("identity playlist search failed:", e)
  }

  if (candidates.length === 0) {
    // Renamed-playlist fallback: the marker survives renames, the name doesn't.
    try {
      for (const pl of await getLibraryPlaylists()) {
        const uid = parseIdentityMarker(pl.description)
        if (uid) candidates.push({ uid, playlistId: pl.id, dateAdded: "" })
      }
    } catch (e) {
      log.net.warn("identity playlist scan failed:", e)
    }
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => (a.dateAdded || "9999").localeCompare(b.dateAdded || "9999"))
  identityPlaylistId = candidates[0].playlistId
  return candidates[0].uid
}

/** Create the identity playlist carrying `uid`. Created empty — it fills up
 *  with the tracks the user saves. Best-effort and single-flight (the boot-
 *  time fire-and-forget call and a fast first save share one POST); a failed
 *  create clears the latch so the next save attempt retries. Resolves to the
 *  new playlist's library id, or null on failure. */
export function createIdentityPlaylist(uid: string): Promise<string | null> {
  identityCreateOp ??= (async () => {
    let id: string | null = null
    try {
      const res = await fetch("https://api.music.apple.com/v1/me/library/playlists", {
        method: "POST",
        headers: { ...headers(), "Content-Type": "application/json" },
        body: JSON.stringify({
          attributes: {
            name: IDENTITY_PLAYLIST_NAME,
            description: `Tracks you save on hat.fm land here. The playlist also remembers who you are — don't delete it. ${IDENTITY_MARKER}${uid}`,
          },
        }),
      })
      if (res.ok) id = (await res.json()).data?.[0]?.id ?? null
      else log.net.warn(`identity playlist create failed: ${res.status}`)
    } catch (e) {
      log.net.warn("identity playlist create failed:", e)
    }
    if (id) {
      identityPlaylistId = id
      identitySavedTracks = []  // brand-new playlist — nothing saved yet
    } else {
      identityCreateOp = null   // let a later save attempt retry
    }
    return id
  })()
  return identityCreateOp
}

/** All tracks currently in the identity playlist, paginated. Returns null on
 *  failure ("unknown" — callers must not treat that as empty). Apple returns
 *  404 for a playlist that has no tracks yet; that one IS empty. */
async function fetchIdentityPlaylistTracks(playlistId: string): Promise<Track[] | null> {
  const out: Track[] = []
  let url = `https://api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?limit=100&include=catalog&fields[songs]=isrc,name,artistName,albumName,artwork,durationInMillis,playParams,offers`
  try {
    while (url) {
      const res = await fetch(url, { headers: headers() })
      if (res.status === 404) break  // tracks relationship absent = empty playlist
      if (!res.ok) return null
      const data = await res.json()
      for (const item of data.data ?? []) out.push(normalizeLibraryTrackWithCatalog(item))
      url = data.next ? `https://api.music.apple.com${data.next}` : ""
    }
  } catch (e) {
    log.net.warn("identity playlist tracks fetch failed:", e)
    return null
  }
  return out
}

/** Single-flight loader for the saved-tracks snapshot. A failed load clears
 *  the latch so the next check/save retries instead of caching the failure. */
function loadIdentitySavedTracks(playlistId: string): Promise<Track[] | null> {
  identitySavedTracksOp ??= fetchIdentityPlaylistTracks(playlistId).then(tracks => {
    if (tracks) identitySavedTracks = tracks
    else identitySavedTracksOp = null
    return tracks
  })
  return identitySavedTracksOp
}

/** Passive "is this track already saved?" check for pre-marking the save
 *  button. Never creates the playlist and never re-searches the library — if
 *  the id isn't already cached (boot-time lookup missed), the answer is
 *  simply false. */
export async function isTrackSavedToLibrary(track: Track): Promise<boolean> {
  if (!identityPlaylistId) return false
  const tracks = identitySavedTracks ?? await loadIdentitySavedTracks(identityPlaylistId)
  return !!tracks?.some(t => sameTrack(t, track))
}

export type LibrarySaveResult = "saved" | "already" | "failed"

/** Append a track to the identity playlist — the "save to your Apple Music
 *  library" button. iCloud sync carries the playlist into the Music app on
 *  all the user's devices. Re-resolves (or creates) the playlist when the id
 *  isn't cached, so it self-heals if the boot-time lookup failed; dedupes
 *  against the playlist contents (ISRC first, via sameTrack) so saves across
 *  sessions and storefronts don't pile up copies. */
export async function saveTrackToIdentityPlaylist(track: Track, uid: string): Promise<LibrarySaveResult> {
  if (!track.appleId) return "failed"
  if (!identityPlaylistId && identityCreateOp) await identityCreateOp  // boot-time create still in flight
  if (!identityPlaylistId) await findIdentityUid()                     // caches the id when it hits
  if (!identityPlaylistId) await createIdentityPlaylist(uid)
  const playlistId = identityPlaylistId
  if (!playlistId) return "failed"

  const existing = identitySavedTracks ?? await loadIdentitySavedTracks(playlistId)
  if (existing?.some(t => sameTrack(t, track))) return "already"

  try {
    const res = await fetch(`https://api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks`, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ data: [{ id: track.appleId, type: "songs" }] }),
    })
    if (!res.ok) {
      log.net.warn(`library save failed: ${res.status}`)
      return "failed"
    }
  } catch (e) {
    log.net.warn("library save failed:", e)
    return "failed"
  }
  identitySavedTracks?.push(track)
  return "saved"
}

export async function getLibraryPlaylistTracks(playlistId: string): Promise<Track[]> {
  const res = await fetch(
    `https://api.music.apple.com/v1/me/library/playlists/${playlistId}/tracks?limit=100&include=catalog&fields[songs]=isrc,name,artistName,albumName,artwork,durationInMillis,playParams,offers`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.data ?? []).map(normalizeLibraryTrackWithCatalog)
}

export async function getLibraryAlbumTracks(albumId: string): Promise<Track[]> {
  const res = await fetch(
    `https://api.music.apple.com/v1/me/library/albums/${albumId}/tracks?limit=100&include=catalog&fields[songs]=isrc,name,artistName,albumName,artwork,durationInMillis,playParams,offers`,
    { headers: headers() }
  )
  if (!res.ok) return []
  const data = await res.json()
  return (data.data ?? []).map(normalizeLibraryTrackWithCatalog)
}

// Shared between library playlists and library albums — both return `library-songs`
// items with an optional `catalog` relationship.
function normalizeLibraryTrackWithCatalog(item: any): Track {
  // Prefer catalog relationship — gives the correct storefront-specific catalog ID.
  // Only use it if the track is actually streamable (has playParams); otherwise fall through
  // so a purchased copy's catalogId can serve as the playable ID instead.
  const catalogItem = item.relationships?.catalog?.data?.[0]
  if (catalogItem) {
    const normalized = normalizeTrack(catalogItem)
    if (normalized?.appleId) return normalized
  }
  // Fall back to playParams.catalogId for purchased tracks not in the catalog.
  const available = normalizeLibraryTrack(item)
  if (available) return available
  // No playable ID at all (local file, DRM-only) — return without an appleId
  // so the UI can display it as unavailable rather than hiding it entirely.
  const a = item.attributes ?? {}
  return {
    isrc: a.isrc ?? "",
    name: a.name ?? "",
    artistName: a.artistName ?? "",
    albumName: a.albumName ?? "",
    artworkUrl: a.artwork?.url ?? "",
    durationMs: a.durationInMillis ?? 0,
  }
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
    tracks: (chart.data ?? []).map(normalizeTrack).filter((t: Track | null): t is Track => t !== null && !!t.appleId)
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
      description: item.attributes?.description?.short ?? item.attributes?.description?.standard ?? "",
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

/** Fetches the tracks of the user's personal "Heavy Rotation" playlist — the
 *  curated, auto-updating mix Apple Music generates per account ("The tracks
 *  you can't get enough of lately").
 *
 *  This playlist is NOT exposed by a dedicated endpoint. It surfaces nested
 *  inside /v1/me/recommendations as a `playlists` resource with a per-user
 *  catalog id of the form `pl.pm-...`. We walk the recommendations groups,
 *  match the playlist name against /heavy rotation/i (loose to survive both
 *  "Heavy Rotation" and "Heavy Rotation Mix" naming variants), then fetch
 *  the playlist tracks via the normal catalog playlist endpoint. */
export async function getHeavyRotationMixTracks(storefront = "us"): Promise<Track[]> {
  const res = await fetch(
    "https://api.music.apple.com/v1/me/recommendations",
    { headers: headers() }
  )
  if (!res.ok) {
    log.net.warn("heavyRotation /v1/me/recommendations HTTP", res.status, res.statusText)
    return []
  }
  const data = await res.json()
  let playlistId: string | null = null
  outer: for (const rec of data.data ?? []) {
    for (const item of rec.relationships?.contents?.data ?? []) {
      if (item.type !== "playlists") continue
      const name = item.attributes?.name ?? ""
      if (/heavy rotation/i.test(name)) {
        playlistId = item.id
        break outer
      }
    }
  }
  if (!playlistId) {
    log.app.warn("heavyRotation: no playlist matching /heavy rotation/i found in recommendations")
    return []
  }
  return getPlaylistTracks(playlistId, storefront)
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
