declare const __COMMIT__: string

// Minimal type declarations for MusicKit JS v3
// Full docs: https://developer.apple.com/documentation/musickitjs

declare namespace MusicKit {
  interface Configuration {
    developerToken: string
    app: {
      name: string
      build: string
      icon?: string
    }
  }

  interface MediaItem {
    id: string
    attributes: {
      name: string
      artistName: string
      albumName: string
      artwork: { url: string; width: number; height: number }
      durationInMillis: number
      isrc?: string
    }
  }

  enum PlaybackStates {
    none = 0,
    loading = 1,
    playing = 2,
    paused = 3,
    stopped = 4,
    ended = 5,
    waiting = 6,
    stalled = 7,
    completed = 8,
  }

  const Events: {
    playbackStateDidChange: string
    nowPlayingItemDidChange: string
    playbackTimeDidChange: string
    authorizationStatusDidChange: string
  }

  interface MusicKitInstance {
    authorize(): Promise<string>
    unauthorize(): Promise<void>
    setQueue(options: { song?: string; songs?: string[] }): Promise<void>
    play(): Promise<void>
    pause(): void
    seekToTime(time: number): Promise<void>
    addEventListener(event: string, callback: (event: any) => void): void
    removeEventListener(event: string, callback: (event: any) => void): void
    readonly isAuthorized: boolean
    readonly nowPlayingItem: MediaItem | null
    readonly playbackState: PlaybackStates
    readonly currentPlaybackTime: number
    readonly currentPlaybackDuration: number
    volume: number
  }

  function configure(config: Configuration): MusicKitInstance
  function getInstance(): MusicKitInstance
}

interface Window {
  MusicKit: typeof MusicKit
}
