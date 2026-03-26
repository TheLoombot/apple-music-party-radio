/**
 * Synchronized playback loop — now driven by PartyKit instead of Firebase.
 *
 * Listens for queue updates from the station socket and drives MusicKit JS
 * so all listeners hear the same track at the same position.
 */
import { stationSocket } from "./partykit"
import { playTrackAtOffset, getMusicKit } from "./musickit"
import type { QueueItem } from "../types"

export class PlaybackLoop {
  private stationId = ""
  private expirationTimer: ReturnType<typeof setTimeout> | null = null
  private currentTrackKey: string | null = null
  private pendingPlay: { catalogId: string; expirationTime: number; durationMs: number } | null = null
  private autoplayEnabled = false   // stays true once user has tapped "Tap to listen"

  onNowPlayingChange?: (item: QueueItem | null) => void
  onQueueChange?: (upNext: QueueItem[]) => void
  onPlaybackBlocked?: () => void

  start(stationId: string) {
    this.stop()
    this.stationId = stationId

    stationSocket.onQueueUpdate = this.handleQueueUpdate
    stationSocket.connect(stationId)
  }

  stop() {
    stationSocket.onQueueUpdate = undefined
    stationSocket.disconnect()
    if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }
    this.currentTrackKey = null
    this.pendingPlay = null
    // intentionally keep autoplayEnabled — once the user has tapped, don't ask again
  }

  async resume() {
    this.autoplayEnabled = true
    if (!this.pendingPlay) return
    const { catalogId, expirationTime, durationMs } = this.pendingPlay
    this.pendingPlay = null
    const offsetSeconds = Math.max(0, (Date.now() - (expirationTime - durationMs)) / 1000)
    try {
      await playTrackAtOffset(catalogId, offsetSeconds)
    } catch (err) {
      console.error("[PlaybackLoop] resume error:", err)
    }
  }

  setMuted(muted: boolean) {
    try { getMusicKit().volume = muted ? 0 : 1 } catch { /* not ready */ }
  }

  private handleQueueUpdate = async (queue: QueueItem[]) => {
    this.onQueueChange?.(queue.slice(1))

    if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }

    if (queue.length === 0) {
      this.onNowPlayingChange?.(null)
      stationSocket.triggerRobotDJ()
      return
    }

    const track0 = queue[0]
    const now = Date.now()

    // Track has passed its expiration — tell the server to expire it
    if (now >= track0.expirationTime) {
      stationSocket.expireTrack(track0.key, /* addToPool */ true)
      return
    }

    // Schedule expiration check
    const delay = track0.expirationTime - now + 500
    this.expirationTimer = setTimeout(() => {
      stationSocket.expireTrack(track0.key, true)
    }, delay)

    this.onNowPlayingChange?.(track0)

    if (track0.key === this.currentTrackKey) return  // already playing

    this.currentTrackKey = track0.key
    const startTime = track0.expirationTime - track0.durationMs
    const offsetSeconds = Math.max(0, (now - startTime) / 1000)

    // Never call play() without a prior user gesture — browser/MusicKit will show
    // a dialog and throw an opaque internal error before we can catch NotAllowedError.
    if (!this.autoplayEnabled) {
      this.pendingPlay = { catalogId: track0.catalogId, expirationTime: track0.expirationTime, durationMs: track0.durationMs }
      this.onPlaybackBlocked?.()
      return
    }

    try {
      await playTrackAtOffset(track0.catalogId, offsetSeconds)
    } catch (err) {
      console.error("[PlaybackLoop] playback error:", err)
    }
  }
}

export const playbackLoop = new PlaybackLoop()
