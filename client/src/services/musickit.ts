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

export async function playTrackAtOffset(catalogId: string, offsetSeconds: number, upNextIds: string[] = []): Promise<void> {
  const music = getMusicKit()
  await music.setQueue({ songs: [catalogId, ...upNextIds] } as any)
  await music.play()
  if (offsetSeconds > 1) {
    await new Promise(r => setTimeout(r, 300))
    await music.seekToTime(offsetSeconds)
  }
}

/**
 * Replace the items queued after the currently-playing track without restarting it.
 * Captures the current playback position, rebuilds the queue, then re-seeks.
 * Only called for user-initiated mutations (the tab is foregrounded), so a brief
 * restart is acceptable.
 */
export async function syncQueueTail(currentId: string, upNextIds: string[]): Promise<void> {
  const music = getMusicKit()
  const t = music.currentPlaybackTime
  await music.setQueue({ songs: [currentId, ...upNextIds] } as any)
  await music.play()
  if (t > 1) {
    await new Promise(r => setTimeout(r, 300))
    await music.seekToTime(t)
  }
}

export function onNowPlayingItemChange(cb: () => void): () => void {
  const handler = () => cb()
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
