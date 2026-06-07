import { log } from "./log"

let initialized = false
let initPromise: Promise<void> | null = null
let _musicUserToken = ""

export async function initMusicKit(): Promise<void> {
  if (initialized) { log.auth.debug("initMusicKit: already initialized"); return }
  if (initPromise) { log.auth.debug("initMusicKit: reusing in-flight promise"); return initPromise }

  initPromise = (async () => {
    await waitForMusicKit()

    const developerToken = import.meta.env.VITE_APPLE_DEVELOPER_TOKEN as string
    if (!developerToken) {
      throw new Error(
        "VITE_APPLE_DEVELOPER_TOKEN is not set.\n" +
        "Run: npm run generate-token   then add the output to your .env file."
      )
    }

    MusicKit.configure({
      developerToken,
      app: { name: "Apple Music Party Radio", build: "1.0.0" }
    })

    // MusicKit restores persisted auth state from localStorage asynchronously.
    // Wait for the authorizationStatusDidChange event, with a timeout fallback.
    await waitForAuthRestore()

    // Attach error listeners early so we catch failures on the very first track.
    try {
      const music = MusicKit.getInstance()
      if (music) attachPlaybackErrorListeners(music)
    } catch (e) {
      log.auth.warn("could not attach MusicKit error listeners:", e)
    }

    initialized = true
  })()

  return initPromise
}

/** MusicKit JS fires playback-related error events that we want to surface in
 *  the log. The exact event names vary across SDK versions, so we listen on
 *  several known/expected names; unknown names are silent no-ops. */
function attachPlaybackErrorListeners(music: MusicKit.MusicKitInstance) {
  // Primary error event — fires when a media item can't be played (DRM,
  // unavailable in storefront, network failure, etc.).
  music.addEventListener("mediaPlaybackError", (e: any) => {
    const item = e?.mediaItem ?? e?.item ?? e?.target
    log.playback.error("MusicKit mediaPlaybackError", {
      code: e?.error?.code ?? e?.code ?? null,
      message: e?.error?.message ?? e?.message ?? null,
      itemId: item?.id ?? null,
      itemName: item?.attributes?.name ?? null,
    })
  })

  // Alternative event name used in some SDK versions.
  music.addEventListener("playbackError", (e: any) => {
    log.playback.error("MusicKit playbackError", e)
  })

  // Fires on every state transition of a media item. We only flag the bad
  // states (`notPlayable`, etc.) — `playable`, `loading`, etc. are normal.
  music.addEventListener("mediaItemStateDidChange", (e: any) => {
    const state = e?.state ?? e?.target?.state
    if (state && /(notPlayable|error|unavailable|restricted)/i.test(String(state))) {
      const item = e?.target ?? e?.mediaItem ?? e?.item
      log.playback.warn("MusicKit media item became unplayable", {
        state,
        itemId: item?.id ?? null,
        itemName: item?.attributes?.name ?? null,
      })
    }
  })
}

async function waitForMusicKitInstance(): Promise<MusicKit.MusicKitInstance | null> {
  for (let i = 0; i < 20; i++) {
    try {
      const m = MusicKit.getInstance()
      if (m) return m
    } catch {}
    await new Promise(r => setTimeout(r, 100))
  }
  return null
}

function waitForAuthRestore(): Promise<void> {
  return new Promise(async (resolve) => {
    const music = await waitForMusicKitInstance()
    if (!music) {
      log.auth.warn("getInstance() still null after 2s — giving up")
      resolve(); return
    }
    if (music.isAuthorized) {
      log.auth.info("already authorized on init")
      resolve(); return
    }

    log.auth.debug("waiting for MusicKit session restore", {
      authorizationStatus: (music as any).authorizationStatus
    })

    const done = (reason: string) => {
      clearTimeout(timer)
      music!.removeEventListener(MusicKit.Events.authorizationStatusDidChange, handler)
      log.auth.info("session restore complete", { reason, isAuthorized: music!.isAuthorized, status: (music as any).authorizationStatus })
      resolve()
    }

    const timer = setTimeout(() => done("timed out after 3000ms"), 3000)

    const handler = () => done("authorizationStatusDidChange fired")

    music.addEventListener(MusicKit.Events.authorizationStatusDidChange, handler)

    // Re-check immediately after attaching the listener — the event may have
    // already fired between configure() and here (race condition)
    if (music.isAuthorized) { done("authorized by re-check after listener attach"); return }
  })
}

function waitForMusicKit(): Promise<void> {
  return new Promise((resolve) => {
    if (window.MusicKit) { resolve(); return }
    document.addEventListener("musickitloaded", () => resolve(), { once: true })
    const t = setInterval(() => { if (window.MusicKit) { clearInterval(t); resolve() } }, 100)
  })
}

export function getMusicKit(): MusicKit.MusicKitInstance {
  const instance = MusicKit.getInstance()
  if (!instance) throw new Error("MusicKit not initialized")
  return instance
}

export async function authorize(): Promise<string> {
  const token = await getMusicKit().authorize()
  _musicUserToken = token
  return token
}

export function getMusicUserToken(): string {
  // _musicUserToken is set on explicit authorize() calls.
  // On refresh it's empty, so fall back to MusicKit's own persisted value.
  if (_musicUserToken) return _musicUserToken
  try { return (getMusicKit() as any).musicUserToken ?? "" } catch { return "" }
}

export function isAuthorized(): boolean {
  try { return getMusicKit().isAuthorized } catch { return false }
}

/** Snapshot MusicKit's native queue state for diagnostic logging. Cheap
 *  read; safe to call even when MusicKit isn't fully initialized. */
export function snapshotNativeQueue(): {
  position: number
  state: number | string
  nowPlaying: string | null
  items: string[]
} | null {
  try {
    const m = getMusicKit() as any
    const q = m.queue
    return {
      position: q.position,
      state: (MusicKit as any).PlaybackStates?.[m.playbackState] ?? m.playbackState,
      nowPlaying: m.nowPlayingItem
        ? `[${m.nowPlayingItem.id}] ${m.nowPlayingItem.attributes?.name ?? "?"}`
        : null,
      items: q.items.map((it: any, i: number) =>
        `${i === q.position ? "▶" : " "} [${it.id}] ${it.attributes?.name ?? "?"}`
      ),
    }
  } catch { return null }
}

/** Returns true if MusicKit is in preview-only mode (no DRM / FairPlay not available).
 *  Detected by checking currentPlaybackDuration after playback starts — previews are ≤30s
 *  even when the track is a full-length song. Chrome lacks FairPlay support. */
export function isPreviewOnly(): boolean {
  try {
    const dur = (getMusicKit() as any).currentPlaybackDuration ?? 0
    return dur > 0 && dur <= 31
  } catch { return false }
}

const muteAudio = (music: MusicKit.MusicKitInstance) => {
  ;(music as any).volume = 0
  const audio = document.querySelector("audio")
  if (audio) audio.muted = true
}

const unmuteAudio = (music: MusicKit.MusicKitInstance) => {
  const audio = document.querySelector("audio")
  if (audio) audio.muted = false
  ;(music as any).volume = 1
}

export async function playTrackAtOffset(catalogId: string, offsetSeconds: number, tailIds?: string[], isCancelled?: () => boolean): Promise<void> {
  const music = getMusicKit()
  const needsSeek = offsetSeconds > 1

  if (!needsSeek) {
    // Restore volume in case a prior fadeOut left it at 0
    unmuteAudio(music)
  } else {
    muteAudio(music)
  }

  if (isCancelled?.()) return

  // Snapshot before/after setQueue so we can prove whether MusicKit actually
  // replaced its queue or kept a phantom item at position 0. Compare these
  // two in the log when a "track bypassed before expiry" warning fires.
  log.sync.debug("setQueue before", { intend: catalogId, tail: tailIds?.length ?? 0, native: snapshotNativeQueue() })
  const tSetQueueStart = performance.now()
  if (tailIds && tailIds.length > 0) {
    await music.setQueue({ songs: [catalogId, ...tailIds] })
  } else {
    await music.setQueue({ song: catalogId })
  }
  log.sync.debug("setQueue after", { ms: Math.round(performance.now() - tSetQueueStart), native: snapshotNativeQueue() })

  // Critical cancel point: if the caller superseded us (station switch, new playAtOffset,
  // or stop()), bail BEFORE play(). The setQueue side-effect on MusicKit's internal queue
  // will be overwritten by the next setQueue. Without this, audio for a stale track starts
  // playing while the UI has already moved on — the exact "song doesn't match Now Playing" bug.
  if (isCancelled?.()) return

  if (needsSeek) {
    muteAudio(music)

    // Intercept the underlying audio element's play() so we can set currentTime
    // before audio starts outputting. MusicKit resets audio.muted on iOS before
    // calling audio.play() internally, making muting alone unreliable.
    // By setting currentTime in the interceptor, the audio starts from offsetSeconds
    // with no audible frames from position 0.
    const el = document.querySelector("audio") as HTMLAudioElement | null
    if (el) {
      const nativePlay = el.play.bind(el)
      ;(el as any).play = function () {
        delete (el as any).play  // restore prototype before calling
        el.currentTime = offsetSeconds
        return nativePlay()
      }
    }
  }

  const tPlayStart = performance.now()
  await music.play()
  log.sync.debug("play() resolved", { ms: Math.round(performance.now() - tPlayStart), state: (music as any).playbackState })

  // After play() — if cancelled, stop the audio we just started so a stale call
  // doesn't leak audibly.
  if (isCancelled?.()) {
    try { music.stop() } catch {}
    return
  }

  if (needsSeek) {
    muteAudio(music)  // re-apply in case play() reset it (belt-and-suspenders for desktop)
    await waitForPlaybackState(music, 2, 2000)
    if (isCancelled?.()) { try { music.stop() } catch {}; return }
    const currentPos = (music as any).currentPlaybackTime ?? 0
    // If the interceptor fired, we're already at offsetSeconds; only re-seek if position is off
    if (Math.abs(offsetSeconds - currentPos) > 3) {
      await music.seekToTime(offsetSeconds)
    }
    if (isCancelled?.()) { try { music.stop() } catch {}; return }
    // Fade in
    const audioEl = document.querySelector("audio")
    if (audioEl) audioEl.muted = false
    const steps = 8
    for (let i = 1; i <= steps; i++) {
      ;(music as any).volume = i / steps
      await new Promise(r => setTimeout(r, 200 / steps))
    }
  }
}

// Wait for MusicKit to reach a given playbackState value, with a timeout fallback.
// Used to ensure seekToTime is called only once the audio element is actually playing,
// not on a fixed timer (which is unreliable across devices and network conditions).
function waitForPlaybackState(music: MusicKit.MusicKitInstance, targetState: number, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    // Attach listener FIRST, then check current state — avoids a race where MusicKit
    // transitions to targetState in the window between the check and addEventListener.
    let timer: ReturnType<typeof setTimeout>
    const handler = (e: any) => {
      if (e.state === targetState) {
        clearTimeout(timer)
        music.removeEventListener(MusicKit.Events.playbackStateDidChange, handler)
        resolve()
      }
    }
    music.addEventListener(MusicKit.Events.playbackStateDidChange, handler)
    if ((music as any).playbackState === targetState) {
      clearTimeout(timer!)
      music.removeEventListener(MusicKit.Events.playbackStateDidChange, handler)
      resolve()
      return
    }
    timer = setTimeout(() => {
      music.removeEventListener(MusicKit.Events.playbackStateDidChange, handler)
      resolve()
    }, timeoutMs)
  })
}

export async function syncQueueTail(tailIds: string[], isCancelled?: () => boolean): Promise<void> {
  if (isCancelled?.()) return
  const music = getMusicKit()
  const nativeQueue = music.queue
  const items = nativeQueue.items
  const position = nativeQueue.position

  // Guard: if MusicKit has no current track (transient state during a track
  // transition, or after a failed setQueue), don't touch the queue. The remove
  // loop below uses `i > position`, which when position === -1 removes EVERY
  // item including the current — leaving the queue with no current track and
  // no audio. The next playAtOffset (e.g. from the next queue_update's hard
  // switch) will rebuild the queue correctly.
  if (position < 0) {
    log.sync.debug("syncQueueTail skipped — position < 0 (MusicKit between tracks)")
    return
  }

  // What's currently in the native queue after the playing track
  const nativeTailIds = items.slice(position + 1).map(item => String(item.id))

  if (nativeTailIds.join(",") === tailIds.join(",")) return  // already in sync

  // Optimisation: if the native tail is already a leading prefix of the desired tail,
  // we only need to append the delta rather than removing and re-adding everything.
  // This is the common case when the robot DJ just appended a new track to a full queue.
  const isPrefixAppend =
    nativeTailIds.length > 0 &&
    nativeTailIds.length < tailIds.length &&
    nativeTailIds.every((id, idx) => tailIds[idx] === id)

  if (isPrefixAppend) {
    const toAdd = tailIds.slice(nativeTailIds.length)
    log.sync.debug("syncQueueTail prefix-append", { adding: toAdd })
    for (const id of toAdd) {
      if (isCancelled?.()) return
      await music.playLater({ song: id })
    }
    return
  }

  log.sync.debug("syncQueueTail full re-sync", {
    position,
    nativeTail: nativeTailIds,
    wantedTail: tailIds,
  })

  // Remove all items after current position — fire all concurrently then await together.
  // Removing back-to-front means indices are stable when the Promises are created.
  const removes: Promise<any>[] = []
  for (let i = items.length - 1; i > position; i--) {
    removes.push(nativeQueue.remove(i))
  }
  await Promise.all(removes)

  if (isCancelled?.()) return

  // Append wanted items in order
  for (const id of tailIds) {
    if (isCancelled?.()) return
    await music.playLater({ song: id })
  }

  log.sync.debug("syncQueueTail done — new tail:", tailIds)
}

/** Call once from the browser console to enable verbose MusicKit queue logging. */
export function debugMusicKit() {
  const music = getMusicKit()

  const logQueue = (label: string) => {
    const q = music.queue
    console.log(`[MusicKit] ${label}`, {
      position: q.position,
      items: q.items.map((item, i) => `${i === q.position ? "▶" : " "} [${item.id}] ${item.attributes?.name} — ${item.attributes?.artistName}`),
      nowPlaying: music.nowPlayingItem ? `[${music.nowPlayingItem.id}] ${music.nowPlayingItem.attributes?.name}` : null,
      playbackState: MusicKit.PlaybackStates[music.playbackState] ?? music.playbackState,
    })
  }

  const events = [
    "nowPlayingItemDidChange",
    "queueItemsDidChange",
    "queuePositionDidChange",
    "playbackStateDidChange",
  ]

  const handlers: Record<string, (e: any) => void> = {}
  for (const event of events) {
    handlers[event] = (e: any) => {
      console.log(`[MusicKit event] ${event}`, e)
      logQueue("after " + event)
    }
    music.addEventListener(event, handlers[event])
  }

  logQueue("initial state")

  console.log("[MusicKit] debug enabled — call window.__stopMusicKitDebug() to remove listeners")
  ;(window as any).__stopMusicKitDebug = () => {
    for (const event of events) music.removeEventListener(event, handlers[event])
    console.log("[MusicKit] debug listeners removed")
  }
}

export function onNowPlayingItemChange(cb: (item: MusicKit.MediaItem | null) => void): () => void {
  const handler = (e: any) => cb(e.item ?? null)
  getMusicKit().addEventListener(MusicKit.Events.nowPlayingItemDidChange, handler)
  return () => getMusicKit().removeEventListener(MusicKit.Events.nowPlayingItemDidChange, handler)
}

export function artworkUrl(template: string, size = 300): string {
  const px = Math.ceil(size * (window.devicePixelRatio || 2))
  return template.replace("{w}", String(px)).replace("{h}", String(px))
}

export function onPlaybackStateChange(cb: (state: MusicKit.PlaybackStates) => void) {
  const handler = (e: any) => cb(e.state)
  getMusicKit().addEventListener(MusicKit.Events.playbackStateDidChange, handler)
  return () => getMusicKit().removeEventListener(MusicKit.Events.playbackStateDidChange, handler)
}
