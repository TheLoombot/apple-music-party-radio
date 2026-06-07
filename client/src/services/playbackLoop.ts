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
 * auto-advance, nowPlayingItemDidChange fires and clears now-playing; the
 * server's alarm then broadcasts the updated queue which repopulates it.
 * Hard switches (new track[0]) use setQueue + seek. Queue tail changes are
 * synced non-destructively via syncQueueTail (remove stale items, append new).
 */
import { stationSocket } from "./partykit"
import { UnavailableError } from "./player"
import { onNowPlayingItemChange, isPreviewOnly } from "./musickit"
import { log } from "./log"
import type { MusicPlayer } from "./player"
import type { QueueItem } from "../types"

export class PlaybackLoop {
  private currentTrack: QueueItem | null = null
  private currentTrackKey: string | null = null
  private nativeCurrentId: string | null = null  // Apple ID we last set as queue[0]
  private playSequence = 0                        // guards stale playAtOffset; bumped by play paths + stop/empty
  private tailSequence = 0                        // guards stale syncQueueTail; bumped by every play/tail path + stop/empty
  private pendingPlay: { track: QueueItem; tail: QueueItem[] } | null = null
  private lastKnownQueue: QueueItem[] = []
  private autoplayEnabled = false
  private muted = false
  private nowPlayingItemTeardown: (() => void) | null = null
  // Latest-wins serializer for queue updates: drops intermediate updates so MusicKit
  // operations from a stale handler can't race with a newer handler.
  private latestQueueUpdate: QueueItem[] | null = null
  private processingQueueUpdate = false
  // Reconciliation tick: detects drift between MusicKit's actual playing track and
  // the UI's expected track (e.g. when an auto-advance event was missed/filtered).
  private reconcileTimer: ReturnType<typeof setInterval> | null = null

  onNowPlayingChange?: (item: QueueItem | null) => void
  onQueueChange?: (upNext: QueueItem[]) => void
  onPlaybackBlocked?: () => void
  onMutedChange?: (muted: boolean) => void
  onPreviewOnly?: () => void
  /** Fires when the actual audio playback state flips (real samples being
   *  produced vs not). See MusicPlayer.isActuallyPlaying for distinction
   *  from the requested/intended state. */
  onActuallyPlayingChange?: (playing: boolean) => void

  // Stall watchdog — when we expect audio (autoplay on, track set, not muted)
  // but isActuallyPlaying stays false for STALL_WINDOW_MS, log a warning so
  // we can spot silent failures (autoplay block, network stall, OS interrupt).
  // No automated retry yet — observation only.
  private static readonly STALL_WINDOW_MS = 3000
  private stallTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private player: MusicPlayer) {
    this.player.onActuallyPlayingChange(playing => {
      this.onActuallyPlayingChange?.(playing)
      this.updateStallWatchdog(playing)
    })
  }

  isActuallyPlaying(): boolean {
    return this.player.isActuallyPlaying()
  }

  private expectsAudio(): boolean {
    return this.autoplayEnabled && !this.muted && this.currentTrack !== null
  }

  private updateStallWatchdog(playing: boolean): void {
    if (playing) {
      if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null }
      return
    }
    if (!this.expectsAudio() || this.stallTimer) return
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null
      if (this.player.isActuallyPlaying() || !this.expectsAudio()) return
      log.playback.warn("stall detected — expected audio but element isn't producing samples", {
        playbackState: (this.player as any).isPlaying?.(),
        track: this.currentTrack?.name,
        autoplayEnabled: this.autoplayEnabled,
        muted: this.muted,
      })
    }, PlaybackLoop.STALL_WINDOW_MS)
  }

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
    this.reconcileTimer = setInterval(this.reconcileTick, 1500)
  }

  stop() {
    // Bump both sequences first — this signals any in-flight playAtOffset/syncQueueTail to
    // bail at their next cancel checkpoint, so a stale setQueue+play from the previous
    // station can't audibly start after we've moved on.
    ++this.playSequence
    ++this.tailSequence
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null }
    document.removeEventListener("visibilitychange", this.handleVisibilityChange)
    this.nowPlayingItemTeardown?.()
    this.nowPlayingItemTeardown = null
    stationSocket.onQueueUpdate = undefined
    stationSocket.disconnect()
    this.player.stop()
    this.currentTrack = null
    this.currentTrackKey = null
    this.nativeCurrentId = null
    this.lastKnownQueue = []
    this.pendingPlay = null
    this.latestQueueUpdate = null
    // Intentionally NOT resetting processingQueueUpdate — if an IIFE is mid-await, letting it
    // exit naturally via its finally block keeps a single IIFE in flight. Resetting here would
    // allow a second IIFE to spawn on the next queue_update and race with the first.
    this.lastSeenDriftId = null
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
      // Track already expired — server alarm will advance the queue
      return
    }
    const startTime = track.expirationTime - track.durationMs
    const offsetSeconds = Math.max(0, Math.min((now - startTime) / 1000, track.durationMs / 1000 - 0.5))
    const seq = ++this.playSequence
    ++this.tailSequence  // play path also supersedes any in-flight tail sync
    this.nativeCurrentId = track.platformIds.apple ?? null
    log.playback.info("play", { source: "resume", track: track.name, offsetSec: Math.round(offsetSeconds) })
    try {
      await this.player.playAtOffset(track, offsetSeconds, tail, () => this.playSequence !== seq)
      if (this.playSequence !== seq) return
    } catch (err) {
      if (err instanceof UnavailableError) {
        log.playback.warn("track unavailable on resume, skipping:", track.name, track.key)
        stationSocket.expireTrack(track.key, false)
      } else {
        log.playback.error("resume error:", err)
      }
    }
  }

  enableAutoplay() {
    this.autoplayEnabled = true
  }

  /** After a fresh playAtOffset, the internal playTrackAtOffset calls
   *  unmuteAudio() to restore volume — which overrides the user's UI mute.
   *  Reapply it so mute survives track changes (cleared only on station
   *  switch via setMuted(false) inside start()). */
  private reassertMute() {
    if (this.muted) this.player.setVolume(0)
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
    ++this.tailSequence  // play path also supersedes any in-flight tail sync
    this.nativeCurrentId = track.platformIds.apple ?? null
    log.playback.info("play", { source: "refresh", track: track.name, offsetSec: Math.round(offsetSeconds) })
    try {
      await this.player.playAtOffset(track, offsetSeconds, tail, () => this.playSequence !== seq)
      if (this.playSequence !== seq) return
      this.reassertMute()
    } catch (err) {
      if (err instanceof UnavailableError) {
        log.playback.warn("track unavailable on refresh, skipping:", track.name, track.key)
        stationSocket.expireTrack(track.key, false)
      } else {
        log.playback.error("refresh error:", err)
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
    log.sync.debug("nowPlayingItemDidChange", {
      itemId,
      nativeCurrentId: this.nativeCurrentId,
      expectedNextId: this.lastKnownQueue[1]?.platformIds?.apple ?? null,
      currentTrackKey: this.currentTrackKey,
    })

    if (!itemId || !this.currentTrackKey) return
    if (itemId === this.nativeCurrentId) return  // same track reloaded (e.g. after setQueue)

    // Match against the FULL queue, not just queue[1]. If MusicKit's actual queue has
    // drifted from the server's (sync race, stress), it may auto-advance to a track
    // further down. Updating the UI to the truth is better than holding stale.
    const matched = this.lastKnownQueue.find(q => q.platformIds?.apple === itemId)
    if (!matched) {
      log.sync.warn("nowPlayingItemDidChange to", itemId, "not in lastKnownQueue — reconcile tick will retry")
      return
    }

    const expectedNextId = this.lastKnownQueue[1]?.platformIds?.apple
    if (itemId !== expectedNextId) {
      log.sync.warn("unexpected native advance — expected", expectedNextId, "got", itemId, "(", matched.name, ") — applying anyway")
    }

    if (isPreviewOnly()) {
      log.playback.warn("preview-only mode detected — suppressing auto-advance")
      this.onPreviewOnly?.()
      return
    }
    // Track the native position so handleQueueUpdate can detect the advance.
    // Advance nowPlaying immediately — avoids a blank "station is quiet"
    // window while waiting for the server's alarm to broadcast the updated queue.
    this.nativeCurrentId = itemId
    log.sync.info("native advance → nowPlaying", matched.name)
    this.onNowPlayingChange?.(matched)
  }

  // Reconcile tick: catches divergence between MusicKit's actual playing track and
  // our `nativeCurrentId`. Backstop for missed nowPlayingItemDidChange events or
  // native queue drift. Requires seeing the same liveId on two consecutive ticks
  // before acting — avoids false positives during setQueue/play transitions where
  // MusicKit's nowPlayingItem can briefly reflect a stale track.
  private lastSeenDriftId: string | null = null
  private reconcileTick = () => {
    if (!this.autoplayEnabled || !this.currentTrack) return
    if (this.processingQueueUpdate) { this.lastSeenDriftId = null; return }  // state in flux
    const liveId = this.player.getLiveCurrentId()
    if (!liveId || liveId === this.nativeCurrentId) {
      this.lastSeenDriftId = null
      return
    }
    // Two-tick confirmation: only reconcile if we saw the same drift previously.
    if (this.lastSeenDriftId !== liveId) {
      this.lastSeenDriftId = liveId
      return
    }
    const matched = this.lastKnownQueue.find(q => q.platformIds?.apple === liveId)
    if (!matched) { this.lastSeenDriftId = null; return }  // unknown track — ignore
    log.sync.warn("reconcile drift: live", liveId, "≠ expected", this.nativeCurrentId, "→ advancing UI to", matched.name)
    this.currentTrack = matched
    this.currentTrackKey = matched.key
    this.nativeCurrentId = liveId
    this.onNowPlayingChange?.(matched)
    this.lastSeenDriftId = null
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
        const seq = ++this.tailSequence
        try {
          await this.player.syncQueueTail(tail, () => this.tailSequence !== seq)
        } catch (err) {
          log.playback.error("visibility restore syncQueueTail error:", err)
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
    ++this.tailSequence  // play path also supersedes any in-flight tail sync
    this.nativeCurrentId = wantedId ?? null
    log.playback.info("play", { source: "visibility", track: track.name, offsetSec: Math.round(offsetSeconds) })
    try {
      await this.player.playAtOffset(track, offsetSeconds, tail, () => this.playSequence !== seq)
      if (this.playSequence !== seq) return
      this.reassertMute()
    } catch (err) {
      if (err instanceof UnavailableError) {
        log.playback.warn("track unavailable on tab focus, skipping:", track.name, track.key)
        stationSocket.expireTrack(track.key, false)
      } else {
        log.playback.error("tab focus restore error:", err)
      }
    }
  }

  // Latest-wins dispatcher. PartyKit can deliver bursts of queue_updates; without
  // serialization, two `processQueueUpdate` invocations race on MusicKit ops
  // (one mid-setQueue while another runs syncQueueTail), leaving the native
  // queue diverged from the server's. We coalesce: the freshest pending queue
  // is processed, intermediates are dropped.
  private handleQueueUpdate = (queue: QueueItem[]): Promise<void> => {
    this.latestQueueUpdate = queue
    if (this.processingQueueUpdate) return Promise.resolve()
    this.processingQueueUpdate = true
    return (async () => {
      try {
        while (this.latestQueueUpdate) {
          const q = this.latestQueueUpdate
          this.latestQueueUpdate = null
          await this.processQueueUpdate(q)
        }
      } finally {
        this.processingQueueUpdate = false
      }
    })()
  }

  private async processQueueUpdate(queue: QueueItem[]) {
    // Snapshot diagnostic — captures every server-driven queue change so the
    // timeline reads as: server pushed N tracks, head is X, expires in Yms.
    const head = queue[0]
    const headChanged = head?.key !== this.currentTrackKey
    log.queue.info("update", {
      count: queue.length,
      head: head ? `${head.name}` : null,
      headChanged,
      etaMs: head ? Math.max(0, head.expirationTime - Date.now()) : null,
    })
    this.onQueueChange?.(queue.slice(1))
    this.lastKnownQueue = queue

    if (queue.length === 0) {
      this.onNowPlayingChange?.(null)
      this.currentTrack = null
      this.currentTrackKey = null
      this.nativeCurrentId = null
      this.pendingPlay = null
      ++this.playSequence  // any in-flight playAtOffset should bail before audibly starting
      ++this.tailSequence  // ditto for syncQueueTail
      this.player.stop()
      // Robot queue is now server-managed. Send a fallback ping in case the server
      // missed filling (e.g. pool was empty at expiry time but tracks were added since).
      stationSocket.triggerRobotDJ()
      return
    }

    const track0 = queue[0]
    const tail = queue.slice(1)
    const now = Date.now()

    // Whether MusicKit has natively advanced past track0 while the server catches up
    const musicKitAlreadyAdvanced = !!this.nativeCurrentId &&
      this.nativeCurrentId !== (track0.platformIds.apple ?? null)

    // ── HARD SWITCH: track[0] changed ─────────────────────────────────────
    if (track0.key !== this.currentTrackKey) {
      this.currentTrack = track0
      this.currentTrackKey = track0.key
      this.onNowPlayingChange?.(track0)

      const wantedId = track0.platformIds.apple ?? null

      // MusicKit already auto-advanced to this track natively — don't call play() again.
      // Either nativeCurrentId was set by handleNowPlayingItemChange (fast path),
      // or we check the live native queue directly (catches the race where handleQueueUpdate
      // runs before nowPlayingItemDidChange fires).
      //
      // BUT: only trust the liveId path when MusicKit is actually playing. After a
      // station switch, musicKit.stop() halts playback but does NOT clear queue.items
      // or nowPlayingItem, so getLiveCurrentId() returns the previous station's track.
      // Trusting it would skip setQueue+play and leave the audio silent (or stale).
      const liveId = this.player.getLiveCurrentId()
      const playerActuallyPlaying = this.player.isPlaying()
      if (wantedId && (wantedId === this.nativeCurrentId || (wantedId === liveId && playerActuallyPlaying))) {
        this.nativeCurrentId = wantedId
        log.sync.info("native auto-advance detected, skipping setQueue", { wantedId, liveId })
        // Do NOT bump playSequence here — this branch starts no new play, so cancelling
        // any in-flight playAtOffset (e.g. handleVisibilityChange's rehydrate) would
        // leave audio silent. Only the tail sync is "new", so only tailSequence bumps.
        const seq = ++this.tailSequence
        try {
          await this.player.syncQueueTail(tail, () => this.tailSequence !== seq)
        } catch (err) {
          log.playback.error("syncQueueTail after auto-advance error:", err)
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
      ++this.tailSequence  // play path also supersedes any in-flight tail sync
      this.nativeCurrentId = wantedId
      log.playback.info("play", { source: "queue-update", track: track0.name, offsetSec: Math.round(offsetSeconds) })
      try {
        await this.player.playAtOffset(track0, offsetSeconds, tail, () => this.playSequence !== seq)
        if (this.playSequence !== seq) return
        this.reassertMute()
      } catch (err) {
        if (err instanceof UnavailableError) {
          log.playback.warn("track unavailable, skipping:", track0.name)
          stationSocket.expireTrack(track0.key, false)
        } else {
          log.playback.error("playback error:", err)
        }
      }
      return
    }

    // ── SOFT UPDATE: same track[0], sync the tail ─────────────────────────
    if (!musicKitAlreadyAdvanced) {
      this.onNowPlayingChange?.(track0)
    } else {
      log.sync.debug("soft update: native already advanced, holding nowPlaying", { nativeCurrentId: this.nativeCurrentId, track0: track0.name })
    }
    // During the transition window (MusicKit advanced to next track, server catching up),
    // compute tail relative to where MusicKit actually is to avoid duplicating now-playing
    let syncTail = tail
    if (musicKitAlreadyAdvanced && this.nativeCurrentId) {
      const advancedToIdx = queue.findIndex(q => q.platformIds?.apple === this.nativeCurrentId)
      if (advancedToIdx >= 0) syncTail = queue.slice(advancedToIdx + 1)
    }
    // Soft update only bumps tailSequence — must NOT cancel an in-flight playAtOffset
    // (e.g. a resume() the user just clicked) for the same track[0].
    const seq = ++this.tailSequence
    try {
      await this.player.syncQueueTail(syncTail, () => this.tailSequence !== seq)
    } catch (err) {
      log.playback.error("syncQueueTail error:", err)
    }
  }
}
