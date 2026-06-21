import {
  searchCatalog,
  SEARCH_PAGE_SIZE,
  getAlbumTracks,
  getPlaylistTracks,
  getLibraryPlaylists,
  getLibraryPlaylistTracks,
  getLibraryAlbumTracks,
  getCharts,
  getHeavyRotationMixTracks,
  getRelatedPlaylistsForSong,
  getAlbumForSong,
  getAlbumEditorial,
  getPlaylistEditorial,
  getSongsByIds,
  getSongsByIsrcs,
} from "./appleMusic"
import type { Track, SearchItem, LibraryPlaylistResult, PlaylistResult, AlbumResult } from "../types"
export type { ChartResult, AlbumEditorialInfo, SearchPage } from "./appleMusic"
export { SEARCH_PAGE_SIZE } from "./appleMusic"
import type { SearchPage } from "./appleMusic"

export interface MusicCatalog {
  search(term: string, offset?: number): Promise<SearchPage>
  getAlbumTracks(albumId: string): Promise<Track[]>
  getPlaylistTracks(playlistId: string): Promise<Track[]>
  getLibraryPlaylists(): Promise<LibraryPlaylistResult[]>
  getLibraryPlaylistTracks(playlistId: string): Promise<Track[]>
  getLibraryAlbumTracks(albumId: string): Promise<Track[]>
  getCharts(): Promise<import("./appleMusic").ChartResult[]>
  getHeavyRotation(): Promise<Track[]>
  getRelatedPlaylists(songId: string): Promise<PlaylistResult[]>
  getAlbumForTrack(songId: string): Promise<AlbumResult | null>
  getAlbumEditorial(albumId: string): Promise<import("./appleMusic").AlbumEditorialInfo>
  getPlaylistEditorial(playlistId: string): Promise<import("./appleMusic").AlbumEditorialInfo>
  getSongsByIds(ids: string[]): Promise<Track[]>
  getSongsByIsrcs(isrcs: string[]): Promise<Track[]>
}

export class AppleMusicCatalog implements MusicCatalog {
  private cache = new Map<string, Promise<any>>()

  constructor(private storefront: string) {}

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, fn())
    return this.cache.get(key)!
  }

  search(term: string, offset = 0) { return searchCatalog(term, this.storefront, offset) }
  getAlbumTracks(id: string) { return this.cached(`album:${id}`, () => getAlbumTracks(id, this.storefront)) }
  getPlaylistTracks(id: string) { return this.cached(`playlist:${id}`, () => getPlaylistTracks(id, this.storefront)) }
  getLibraryPlaylists() { return getLibraryPlaylists() }
  getLibraryPlaylistTracks(id: string) { return getLibraryPlaylistTracks(id) }
  getLibraryAlbumTracks(id: string) { return this.cached(`library-album:${id}`, () => getLibraryAlbumTracks(id)) }
  getCharts() { return getCharts(this.storefront) }
  getHeavyRotation() { return this.cached("heavyRotation", () => getHeavyRotationMixTracks(this.storefront)) }
  getRelatedPlaylists(songId: string) { return getRelatedPlaylistsForSong(songId, this.storefront) }
  getAlbumForTrack(songId: string) { return this.cached(`albumFor:${songId}`, () => getAlbumForSong(songId, this.storefront)) }
  // Cached so the ArtworkFlip display and the add-time embedding share one
  // fetch per album/playlist for the whole session (and repeated art flips
  // stop re-fetching).
  getAlbumEditorial(albumId: string) { return this.cached(`albumEditorial:${albumId}`, () => getAlbumEditorial(albumId, this.storefront)) }
  getPlaylistEditorial(playlistId: string) { return this.cached(`playlistEditorial:${playlistId}`, () => getPlaylistEditorial(playlistId, this.storefront)) }
  getSongsByIds(ids: string[]) { return getSongsByIds(ids, this.storefront) }
  getSongsByIsrcs(isrcs: string[]) { return getSongsByIsrcs(isrcs, this.storefront) }
}
