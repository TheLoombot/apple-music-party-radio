import {
  searchCatalog,
  getAlbumTracks,
  getPlaylistTracks,
  getLibraryPlaylists,
  getLibraryPlaylistTracks,
  getChartSongs,
  getRecommendedPlaylists,
  getRelatedPlaylistsForSong,
} from "./appleMusic"
import type { Track, SearchItem, LibraryPlaylistResult, PlaylistResult } from "../types"

export interface MusicCatalog {
  search(term: string): Promise<SearchItem[]>
  getAlbumTracks(albumId: string): Promise<Track[]>
  getPlaylistTracks(playlistId: string): Promise<Track[]>
  getLibraryPlaylists(): Promise<LibraryPlaylistResult[]>
  getLibraryPlaylistTracks(playlistId: string): Promise<Track[]>
  getChartSongs(): Promise<Track[]>
  getRecommendedPlaylists(): Promise<PlaylistResult[]>
  getRelatedPlaylists(songId: string): Promise<PlaylistResult[]>
}

export class AppleMusicCatalog implements MusicCatalog {
  constructor(private storefront: string) {}

  search(term: string) { return searchCatalog(term, this.storefront) }
  getAlbumTracks(id: string) { return getAlbumTracks(id, this.storefront) }
  getPlaylistTracks(id: string) { return getPlaylistTracks(id, this.storefront) }
  getLibraryPlaylists() { return getLibraryPlaylists() }
  getLibraryPlaylistTracks(id: string) { return getLibraryPlaylistTracks(id) }
  getChartSongs() { return getChartSongs(this.storefront) }
  getRecommendedPlaylists() { return getRecommendedPlaylists() }
  getRelatedPlaylists(songId: string) { return getRelatedPlaylistsForSong(songId, this.storefront) }
}
