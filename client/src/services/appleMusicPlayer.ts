import { playTrackAtOffset, getMusicKit } from "./musickit"
import { UnavailableError } from "./player"
import type { MusicPlayer } from "./player"
import type { QueueItem } from "../types"

export class AppleMusicPlayer implements MusicPlayer {
  async playAtOffset(track: QueueItem, offsetSeconds: number): Promise<void> {
    const appleId = track.platformIds.apple
    if (!appleId) throw new UnavailableError("apple", track)
    await playTrackAtOffset(appleId, offsetSeconds)
  }

  stop() {
    try { (getMusicKit() as any).stop() } catch { /* not ready */ }
  }

  isPlaying(): boolean {
    try {
      const music = getMusicKit() as any
      return music.playbackState === 2  // MusicKit.PlaybackStates.playing
    } catch { return false }
  }

  setVolume(level: number) {
    try { (getMusicKit() as any).volume = level } catch { /* not ready */ }
    // iOS Safari ignores programmatic volume changes; toggle muted as fallback
    try {
      const audio = document.querySelector("audio")
      if (audio) audio.muted = (level === 0)
    } catch { /* not ready */ }
  }
}
