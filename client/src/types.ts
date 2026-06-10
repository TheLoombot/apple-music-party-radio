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
  addedByName?: string
  addedAt: number
}

export interface BrowsableResult {
  id: string
  name: string
  subtitle: string   // artistName for albums, curator for playlists
  artworkUrl: string
  description?: string  // playlist description — shown in PlaylistRow, matched by the LISTS filter
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
  catalogId?: string       // catalog counterpart (subscribed playlists only) — enables editorial fetch
}

export interface LibraryAlbumResult extends BrowsableResult {
  kind: "library-album"
  trackCount?: number
}

export type SearchItem =
  | { kind: "song"; track: Track }
  | AlbumResult
  | PlaylistResult

export interface Listener {
  userId: string
  displayName: string
  isDJ?: boolean
}

export interface Station {
  id: string            // station slug (= PartyKit room name)
  displayName: string
  storefront: string
  liveUntil: number    // Unix ms; station is live if liveUntil > Date.now()
  frequency?: number        // FM frequency 66.6–109.9, assigned at creation
  ownerUid?: string         // set at creation; undefined for legacy rooms until migrated
  ownerDisplayName?: string // persisted on register so it's known even when owner is offline
  nowPlayingAddedBy?: string
  nowPlayingAddedByName?: string
  nowPlayingTrackName?: string
  nowPlayingArtistName?: string
  nowPlayingArtworkUrl?: string
  listeners?: Listener[]
}

export interface SuggestedTrack extends Track {
  key: string
  suggestedBy: string
  suggestedByName?: string
  suggestedAt: number
  votes: number
  votedBy: string[]
}

export interface PoolTrack extends Track {
  lastPlayedAt: number
  addedByUsers: string[]
  // uid → most-recent-known displayName. Optional because legacy pool entries
  // saved before the names map was added don't have it.
  addedByNames?: Record<string, string>
  playCount: number
}

/** A chat message in the station log. */
export interface UserLogEntry {
  kind: "user"
  id: string
  userId: string
  displayName: string
  text: string
  postedAt: number
}

/** Track-change marker in the station log — rendered as a divider, not a
 *  message. Logged server-side whenever the queue head changes. */
export interface TrackLogEntry {
  kind: "track"
  id: string
  trackKey: string
  title: string
  artist: string
  postedAt: number
}

/** Station chat log entry. The log is a single capped array (oldest first);
 *  track dividers count toward the cap, so old chatter scrolls out. */
export type LogEntry = UserLogEntry | TrackLogEntry

/** Record that a user was present in the room at some point. Updated on
 *  join and on disconnect (lastSeenAt = the most recent of those moments).
 *  Lets the recent list include users who passed through without commenting. */
export interface Visit {
  userId: string
  displayName: string
  lastSeenAt: number
}

export interface AppUser {
  uid: string
  displayName: string
  storefront: string
}
