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
} from "./appleMusic"
import type { Track, SearchItem, LibraryPlaylistResult, PlaylistResult, AlbumResult } from "../types"
export type { ChartResult } from "./appleMusic"

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
}

export class AppleMusicCatalog implements MusicCatalog {
  constructor(private storefront: string) {}

  search(term: string) { return searchCatalog(term, this.storefront) }
  getAlbumTracks(id: string) { return getAlbumTracks(id, this.storefront) }
  getPlaylistTracks(id: string) { return getPlaylistTracks(id, this.storefront) }
  getLibraryPlaylists() { return getLibraryPlaylists() }
  getLibraryPlaylistTracks(id: string) { return getLibraryPlaylistTracks(id) }
  getCharts() { return getCharts(this.storefront) }
  getRecommendedPlaylists() { return getRecommendedPlaylists() }
  getRelatedPlaylists(songId: string) { return getRelatedPlaylistsForSong(songId, this.storefront) }
  getAlbumForTrack(songId: string) { return getAlbumForSong(songId, this.storefront) }
}
