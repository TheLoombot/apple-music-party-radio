export type Platform = "apple" | "spotify"

export interface PlatformIds {
  apple?: string    // Apple Music catalog ID (numeric string)
  spotify?: string  // Spotify track ID
}

export interface Track {
  isrc: string
  platformIds: PlatformIds
  addedViaPlatform: Platform
  name: string
  artistName: string
  albumName: string
  artworkUrl: string   // Apple Music: {w}x{h} template; Spotify: direct URL
  durationMs: number
}

export interface QueueItem extends Track {
  key: string
  expirationTime: number
  addedBy: string
  addedAt: number
}

export interface BrowsableResult {
  id: string
  name: string
  subtitle: string   // artistName for albums, curator for playlists
  artworkUrl: string
}

export interface AlbumResult extends BrowsableResult {
  kind: "album"
  releaseYear?: number
}

export interface PlaylistResult extends BrowsableResult {
  kind: "playlist"
  lastModifiedAt?: number  // Unix ms
}

export interface LibraryPlaylistResult extends BrowsableResult {
  kind: "library-playlist"
  trackCount?: number
  lastModifiedAt?: number  // Unix ms
}

export type SearchItem =
  | { kind: "song"; track: Track }
  | AlbumResult
  | PlaylistResult

export interface Listener {
  userId: string
  displayName: string
}

export interface Station {
  id: string            // owner's userId (= PartyKit room name)
  displayName: string
  storefront: string
  liveUntil: number    // Unix ms; station is live if liveUntil > Date.now()
  nowPlayingAddedBy?: string
  nowPlayingTrackName?: string
  nowPlayingArtistName?: string
  listeners?: Listener[]
}

export interface PoolTrack extends Track {
  lastPlayedAt: number
  addedByUsers: string[]
  playCount: number
}

export interface ChatMessage {
  id: string
  userId: string
  displayName: string
  text: string
  sentAt: number
}

export interface AppUser {
  uid: string
  displayName: string
  storefront: string
}
