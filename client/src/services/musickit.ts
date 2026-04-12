let initialized = false
let initPromise: Promise<void> | null = null
let _musicUserToken = ""

export async function initMusicKit(): Promise<void> {
  if (initialized) { console.log("[auth] initMusicKit: already initialized"); return }
  if (initPromise) { console.log("[auth] initMusicKit: reusing in-flight promise"); return initPromise }

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

    initialized = true
  })()

  return initPromise
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
      console.warn("[auth] getInstance() still null after 2s — giving up")
      resolve(); return
    }
    if (music.isAuthorized) {
      console.log("[auth] already authorized on init")
      resolve(); return
    }

    console.log("[auth] waiting for MusicKit session restore…", {
      authorizationStatus: (music as any).authorizationStatus
    })

    const done = (reason: string) => {
      clearTimeout(timer)
      music!.removeEventListener(MusicKit.Events.authorizationStatusDidChange, handler)
      console.log(`[auth] resolve: ${reason} — isAuthorized:`, music!.isAuthorized,
        "authorizationStatus:", (music as any).authorizationStatus)
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

/** Returns true if MusicKit is in preview-only mode (no DRM / FairPlay not available).
 *  Detected by checking currentPlaybackDuration after playback starts — previews are ≤30s
 *  even when the track is a full-length song. Chrome lacks FairPlay support. */
export function isPreviewOnly(): boolean {
  try {
    const dur = (getMusicKit() as any).currentPlaybackDuration ?? 0
    return dur > 0 && dur <= 31
  } catch { return false }
}

export async function playTrackAtOffset(catalogId: string, offsetSeconds: number, tailIds?: string[]): Promise<void> {
  const music = getMusicKit()
  if (tailIds && tailIds.length > 0) {
    await music.setQueue({ songs: [catalogId, ...tailIds] })
  } else {
    await music.setQueue({ song: catalogId })
  }
  await music.play()
  if (offsetSeconds > 1) {
    await waitForPlaybackState(music, 2, 2000)
    const currentPos = (music as any).currentPlaybackTime ?? 0
    if (Math.abs(offsetSeconds - currentPos) > 3) {
      await music.seekToTime(offsetSeconds)
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

export async function syncQueueTail(tailIds: string[]): Promise<void> {
  const music = getMusicKit()
  const nativeQueue = music.queue
  const items = nativeQueue.items
  const position = nativeQueue.position

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
    console.debug("[MusicKit queue] syncQueueTail prefix-append", { adding: toAdd })
    for (const id of toAdd) {
      await music.playLater({ song: id })
    }
    return
  }

  console.debug("[MusicKit queue] syncQueueTail full re-sync", {
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

  // Append wanted items in order
  for (const id of tailIds) {
    await music.playLater({ song: id })
  }

  console.debug("[MusicKit queue] syncQueueTail done — new tail:", tailIds)
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
