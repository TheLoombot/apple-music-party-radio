/**
 * Synchronized playback loop — driven by PartyKit queue state.
 *
 * Listens for queue updates from the station socket and drives a MusicPlayer
 * so all listeners hear the same track at the same position.
 *
 * The server is authoritative on queue advancement — its Durable Object alarm
 * fires at each track's expirationTime and broadcasts the updated queue.
 * The client also keeps a fallback expiration timer (belt-and-suspenders for
 * local dev and foreground reliability).
 *
 * Native queue: we keep the full MusicKit queue in sync with the app queue so
 * that track transitions happen natively without JS needing to fire. On
 * auto-advance, nowPlayingItemDidChange fires and we tell the server.
 * Hard switches (new track[0]) use setQueue + seek. Queue tail changes are
 * synced non-destructively via syncQueueTail (remove stale items, append new).
 */
import { stationSocket } from "./partykit"
import { UnavailableError } from "./player"
import { onNowPlayingItemChange, isPreviewOnly } from "./musickit"
import type { MusicPlayer } from "./player"
import type { QueueItem } from "../types"

export class PlaybackLoop {
  private currentTrack: QueueItem | null = null
  private currentTrackKey: string | null = null
  private nativeCurrentId: string | null = null  // Apple ID we last set as queue[0]
  private playSequence = 0                        // guards against stale async writes
  private pendingPlay: { track: QueueItem; tail: QueueItem[] } | null = null
  private lastKnownQueue: QueueItem[] = []
  private autoplayEnabled = false
  private muted = false
  private expirationTimer: ReturnType<typeof setTimeout> | null = null
  private nowPlayingItemTeardown: (() => void) | null = null

  onNowPlayingChange?: (item: QueueItem | null) => void
  onQueueChange?: (upNext: QueueItem[]) => void
  onPlaybackBlocked?: () => void
  onMutedChange?: (muted: boolean) => void
  onPreviewOnly?: () => void

  constructor(private player: MusicPlayer) {}

  async start(stationId: string) {
    if (this.autoplayEnabled && this.player.isPlaying()) {
      await this.player.fadeOut(200)
    }
    this.stop()
    this.setMuted(false)
    stationSocket.onQueueUpdate = this.handleQueueUpdate
    stationSocket.connect(stationId)
    document.addEventListener("visibilitychange", this.handleVisibilityChange)
    this.nowPlayingItemTeardown = onNowPlayingItemChange(this.handleNowPlayingItemChange)
  }

  stop() {
    document.removeEventListener("visibilitychange", this.handleVisibilityChange)
    this.nowPlayingItemTeardown?.()
    this.nowPlayingItemTeardown = null
    stationSocket.onQueueUpdate = undefined
    stationSocket.disconnect()
    this.currentTrack = null
    this.currentTrackKey = null
    this.nativeCurrentId = null
    this.lastKnownQueue = []
    this.pendingPlay = null
    if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }
    // intentionally keep autoplayEnabled — once the user has tapped, don't ask again
  }

  async resume() {
    this.autoplayEnabled = true
    this.setMuted(false)
    if (!this.pendingPlay) return
    const { track, tail } = this.pendingPlay
    this.pendingPlay = null
    // Recalculate offset at resume time — pendingPlay may have been set seconds/minutes ago
    const now = Date.now()
    if (now >= track.expirationTime) {
      // Track already expired while waiting — tell server and bail
      stationSocket.expireTrack(track.key, true)
      return
    }
    const startTime = track.expirationTime - track.durationMs
    const offsetSeconds = Math.max(0, Math.min((now - startTime) / 1000, track.durationMs / 1000 - 0.5))
    const seq = ++this.playSequence
    this.nativeCurrentId = track.platformIds.apple ?? null
    try {
      await this.player.playAtOffset(track, offsetSeconds, tail)
      if (this.playSequence !== seq) return
    } catch (err) {
      if (err instanceof UnavailableError) {
        console.warn("[PlaybackLoop] track unavailable on resume:", track.name)
      } else {
        console.error("[PlaybackLoop] resume error:", err)
      }
    }
  }

  enableAutoplay() {
    this.autoplayEnabled = true
  }

  /** Re-play the current track from the correct sync offset. Call after re-authorization. */
  async refresh() {
    if (!this.autoplayEnabled || !this.currentTrack) return
    const track = this.currentTrack
    const now = Date.now()
    if (now >= track.expirationTime) return
    const startTime = track.expirationTime - track.durationMs
    const offsetSeconds = Math.max(0, Math.min((now - startTime) / 1000, track.durationMs / 1000 - 0.5))
    const tail = this.lastKnownQueue.slice(1)
    const seq = ++this.playSequence
    this.nativeCurrentId = track.platformIds.apple ?? null
    try {
      await this.player.playAtOffset(track, offsetSeconds, tail)
      if (this.playSequence !== seq) return
    } catch (err) {
      if (err instanceof UnavailableError) {
        console.warn("[PlaybackLoop] refresh: track unavailable:", track.name)
      } else {
        console.error("[PlaybackLoop] refresh error:", err)
      }
    }
  }

  setMuted(muted: boolean) {
    this.muted = muted
    this.player.setVolume(muted ? 0 : 1)
    this.onMutedChange?.(muted)
  }

  // MusicKit auto-advanced to the next track natively.
  private handleNowPlayingItemChange = (item: MusicKit.MediaItem | null) => {
    const itemId = item ? String(item.id) : null
    console.debug("[PlaybackLoop] nowPlayingItemDidChange", {
      itemId,
      nativeCurrentId: this.nativeCurrentId,
      expectedNextId: this.lastKnownQueue[1]?.platformIds?.apple ?? null,
      currentTrackKey: this.currentTrackKey,
    })

    if (!itemId || !this.currentTrackKey) return
    if (itemId === this.nativeCurrentId) return  // same track reloaded (e.g. after setQueue)

    const expectedNextId = this.lastKnownQueue[1]?.platformIds?.apple
    if (!expectedNextId || itemId !== expectedNextId) return

    // MusicKit moved forward on its own — tell the server.
    // Skip if in preview-only mode (Chrome/no FairPlay DRM): the preview auto-advanced
    // after 30 s but the server track is still live; don't cascade rapid expires.
    if (isPreviewOnly()) {
      console.warn("[PlaybackLoop] preview-only mode detected — suppressing auto-advance expire")
      this.onPreviewOnly?.()
      return
    }
    this.nativeCurrentId = itemId
    if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }
    stationSocket.expireTrack(this.currentTrackKey, true)
  }

  private handleVisibilityChange = async () => {
    if (document.hidden) return
    if (!this.autoplayEnabled || !this.currentTrack) return

    if (this.player.isPlaying()) {
      // Reconcile: check whether MusicKit is playing the track we expect.
      // If backgrounded long enough for one or more auto-advances, this.currentTrack
      // still points at the old track while MusicKit is on a newer one.
      const liveId = this.player.getLiveCurrentId()
      const wantedId = this.currentTrack.platformIds.apple
      if (liveId && wantedId && liveId !== wantedId) {
        const matchedIndex = this.lastKnownQueue.findIndex(
          q => q.platformIds?.apple === liveId
        )
        if (matchedIndex >= 0) {
          // Re-run handleQueueUpdate from the matched track's position.
          // The hard-switch path will detect native auto-advance (wantedId === liveId),
          // skip playAtOffset, update all state pointers, and sync the tail.
          await this.handleQueueUpdate(this.lastKnownQueue.slice(matchedIndex))
          return
        }
      }

      // Track matches (or not found in lastKnownQueue) — sync tail only.
      const tail = this.lastKnownQueue.slice(1)
      if (tail.length > 0) {
        try {
          await this.player.syncQueueTail(tail)
        } catch (err) {
          console.error("[PlaybackLoop] visibility restore syncQueueTail error:", err)
        }
      }
      return
    }

    // Playback stopped — rehydrate at the correct offset.
    const liveId = this.player.getLiveCurrentId()
    const wantedId = this.currentTrack.platformIds.apple
    // Note: we intentionally do NOT early-return when liveId === wantedId here.
    // iOS can pause the audio while backgrounded even with the right track loaded —
    // we must seek to the correct offset and resume.

    const track = this.currentTrack
    const now = Date.now()
    if (now >= track.expirationTime) return  // already expired — wait for next queue_update

    const startTime = track.expirationTime - track.durationMs
    const offsetSeconds = Math.max(0, Math.min((now - startTime) / 1000, track.durationMs / 1000 - 0.5))
    const tail = this.lastKnownQueue.slice(1)
    const seq = ++this.playSequence
    this.nativeCurrentId = wantedId ?? null
    try {
      await this.player.playAtOffset(track, offsetSeconds, tail)
      if (this.playSequence !== seq) return
    } catch (err) {
      if (err instanceof UnavailableError) {
        console.warn("[PlaybackLoop] track unavailable on tab focus:", track.name)
      } else {
        console.error("[PlaybackLoop] tab focus restore error:", err)
      }
    }
  }

  private handleQueueUpdate = async (queue: QueueItem[]) => {
    this.onQueueChange?.(queue.slice(1))
    this.lastKnownQueue = queue

    if (queue.length === 0) {
      this.onNowPlayingChange?.(null)
      this.currentTrack = null
      this.currentTrackKey = null
      this.nativeCurrentId = null
      this.pendingPlay = null
      if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }
      this.player.stop()
      // Robot queue is now server-managed. Send a fallback ping in case the server
      // missed filling (e.g. pool was empty at expiry time but tracks were added since).
      stationSocket.triggerRobotDJ()
      return
    }

    const track0 = queue[0]
    const tail = queue.slice(1)
    const now = Date.now()

    this.onNowPlayingChange?.(track0)

    // ── HARD SWITCH: track[0] changed ─────────────────────────────────────
    if (track0.key !== this.currentTrackKey) {
      this.currentTrack = track0
      this.currentTrackKey = track0.key

      // Track is already past its end — skip it immediately without playing.
      // This handles the "catch-up storm" after a long background session where
      // multiple tracks expire while JS is throttled.
      if (now >= track0.expirationTime - 500) {
        if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }
        stationSocket.expireTrack(track0.key, true)
        return
      }

      if (this.expirationTimer) clearTimeout(this.expirationTimer)
      // +3s grace: lets MusicKit's nowPlayingItemDidChange fire first (which cancels this timer).
      // This prevents our setQueue from racing with MusicKit's natural auto-advance.
      this.expirationTimer = setTimeout(() => {
        if (this.currentTrackKey === track0.key) {
          stationSocket.expireTrack(track0.key, true)
        }
      }, Math.max(0, track0.expirationTime - Date.now() + 3000))

      const wantedId = track0.platformIds.apple ?? null

      // MusicKit already auto-advanced to this track natively — don't call play() again.
      // Either nativeCurrentId was set by handleNowPlayingItemChange (fast path),
      // or we check the live native queue directly (catches the race where expirationTimer
      // fires and handleQueueUpdate runs before nowPlayingItemDidChange fires).
      const liveId = this.player.getLiveCurrentId()
      if (wantedId && (wantedId === this.nativeCurrentId || wantedId === liveId)) {
        this.nativeCurrentId = wantedId
        console.debug("[PlaybackLoop] native auto-advance detected, skipping setQueue", { wantedId, liveId, nativeCurrentId: this.nativeCurrentId })
        try {
          await this.player.syncQueueTail(tail)
        } catch (err) {
          console.error("[PlaybackLoop] syncQueueTail after auto-advance error:", err)
        }
        return
      }

      const startTime = track0.expirationTime - track0.durationMs
      const offsetSeconds = Math.max(0, Math.min((now - startTime) / 1000, track0.durationMs / 1000 - 0.5))

      if (!this.autoplayEnabled) {
        this.pendingPlay = { track: track0, tail }
        this.onPlaybackBlocked?.()
        return
      }

      const seq = ++this.playSequence
      this.nativeCurrentId = wantedId
      try {
        // Pass full tail so setQueue loads the complete queue atomically —
        // this is what enables native background auto-advance without JS timers.
        await this.player.playAtOffset(track0, offsetSeconds, tail)
        if (this.playSequence !== seq) return
      } catch (err) {
        if (err instanceof UnavailableError) {
          console.warn("[PlaybackLoop] track unavailable, skipping:", track0.name)
          if (this.expirationTimer) { clearTimeout(this.expirationTimer); this.expirationTimer = null }
          stationSocket.expireTrack(track0.key, false)
        } else {
          console.error("[PlaybackLoop] playback error:", err)
        }
      }
      return
    }

    // ── SOFT UPDATE: same track[0], sync the tail ─────────────────────────
    try {
      await this.player.syncQueueTail(tail)
    } catch (err) {
      console.error("[PlaybackLoop] syncQueueTail error:", err)
    }
  }
}
