export interface Track {
  catalogId: string
  isrc: string
  name: string
  artistName: string
  albumName: string
  artworkUrl: string
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
}

export interface PlaylistResult extends BrowsableResult {
  kind: "playlist"
}

export interface LibraryPlaylistResult extends BrowsableResult {
  kind: "library-playlist"
  trackCount?: number
}

export type SearchItem =
  | { kind: "song"; track: Track }
  | AlbumResult
  | PlaylistResult

export interface Station {
  id: string            // owner's userId (= PartyKit room name)
  displayName: string
  storefront: string
  isLive: boolean
}

export interface AppUser {
  uid: string
  storefront: string
  displayName: string
}
