import { playTrackAtOffset, syncQueueTail, getMusicKit } from "./musickit"
import { UnavailableError } from "./player"
import type { MusicPlayer } from "./player"
import type { QueueItem } from "../types"

export class AppleMusicPlayer implements MusicPlayer {
  async playAtOffset(track: QueueItem, offsetSeconds: number, tail?: QueueItem[]): Promise<void> {
    const appleId = track.platformIds.apple
    if (!appleId) throw new UnavailableError("apple", track)
    const tailIds = tail?.map(t => t.platformIds.apple).filter((id): id is string => !!id)
    await playTrackAtOffset(appleId, offsetSeconds, tailIds)
  }

  async syncQueueTail(tailTracks: QueueItem[]): Promise<void> {
    const tailIds = tailTracks.map(t => t.platformIds.apple).filter((id): id is string => !!id)
    await syncQueueTail(tailIds)
  }

  stop() {
    try { getMusicKit().stop() } catch { /* not ready */ }
  }

  getLiveCurrentId(): string | null {
    try {
      const music = getMusicKit()
      // nowPlayingItem is set once MusicKit commits to the new track
      if (music.nowPlayingItem?.id) return String(music.nowPlayingItem.id)
      // queue.items[position] is set as soon as position advances (before nowPlayingItem)
      const q = music.queue
      if (q.position >= 0 && q.items[q.position]?.id) return String(q.items[q.position].id)
      return null
    } catch { return null }
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
