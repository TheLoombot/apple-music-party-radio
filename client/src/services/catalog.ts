import {
  searchCatalog,
  getAlbumTracks,
  getPlaylistTracks,
  getLibraryPlaylists,
  getLibraryPlaylistTracks,
  getCharts,
  getRecommendedPlaylists,
  getRelatedPlaylistsForSong,
  getAlbumForSong,
  getAlbumEditorial,
  getPlaylistEditorial,
} from "./appleMusic"
import type { Track, SearchItem, LibraryPlaylistResult, PlaylistResult, AlbumResult } from "../types"
export type { ChartResult, AlbumEditorialInfo } from "./appleMusic"

export interface MusicCatalog {
  search(term: string): Promise<SearchItem[]>
  getAlbumTracks(albumId: string): Promise<Track[]>
  getPlaylistTracks(playlistId: string): Promise<Track[]>
  getLibraryPlaylists(): Promise<LibraryPlaylistResult[]>
  getLibraryPlaylistTracks(playlistId: string): Promise<Track[]>
  getCharts(): Promise<import("./appleMusic").ChartResult[]>
  getRecommendedPlaylists(): Promise<(PlaylistResult | AlbumResult)[]>
  getRelatedPlaylists(songId: string): Promise<PlaylistResult[]>
  getAlbumForTrack(songId: string): Promise<AlbumResult | null>
  getAlbumEditorial(albumId: string): Promise<import("./appleMusic").AlbumEditorialInfo>
  getPlaylistEditorial(playlistId: string): Promise<import("./appleMusic").AlbumEditorialInfo>
}

export class AppleMusicCatalog implements MusicCatalog {
  private cache = new Map<string, Promise<any>>()

  constructor(private storefront: string) {}

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.cache.has(key)) this.cache.set(key, fn())
    return this.cache.get(key)!
  }

  search(term: string) { return searchCatalog(term, this.storefront) }
  getAlbumTracks(id: string) { return this.cached(`album:${id}`, () => getAlbumTracks(id, this.storefront)) }
  getPlaylistTracks(id: string) { return this.cached(`playlist:${id}`, () => getPlaylistTracks(id, this.storefront)) }
  getLibraryPlaylists() { return getLibraryPlaylists() }
  getLibraryPlaylistTracks(id: string) { return getLibraryPlaylistTracks(id) }
  getCharts() { return getCharts(this.storefront) }
  getRecommendedPlaylists() { return getRecommendedPlaylists() }
  getRelatedPlaylists(songId: string) { return getRelatedPlaylistsForSong(songId, this.storefront) }
  getAlbumForTrack(songId: string) { return this.cached(`albumFor:${songId}`, () => getAlbumForSong(songId, this.storefront)) }
  getAlbumEditorial(albumId: string) { return getAlbumEditorial(albumId, this.storefront) }
  getPlaylistEditorial(playlistId: string) { return getPlaylistEditorial(playlistId, this.storefront) }
}
