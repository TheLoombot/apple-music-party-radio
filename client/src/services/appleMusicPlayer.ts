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
    try { getMusicKit().stop() } catch { /* not ready */ }
  }

  setVolume(level: number) {
    try { getMusicKit().volume = level } catch { /* not ready */ }
  }
}
