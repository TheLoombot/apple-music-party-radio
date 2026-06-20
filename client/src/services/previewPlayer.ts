// Track preview player — plays the free ~30s catalog excerpt over the
// currently-playing station track. It owns its OWN <audio> element (created
// via `new Audio()`), deliberately separate from MusicKit's element so the two
// never fight over one stream. While a preview plays, the main track is ducked
// (desktop) or muted (mobile) via the onDuck/onUnduck callbacks — the station
// keeps advancing on its wall-clock timeline either way, preserving the radio
// metaphor, and the caller re-syncs to the live position when the preview ends.
//
// Only one preview plays at a time. The element is reused across previews.

type Listener = (previewingId: string | null) => void

class PreviewPlayer {
  private audio: HTMLAudioElement | null = null
  private currentId: string | null = null
  private listeners = new Set<Listener>()

  /** Fired when a preview starts while nothing was previewing — duck the main
   *  track. Switching directly from one preview to another does NOT re-fire. */
  onDuck?: () => void
  /** Fired when previewing fully stops (ended, error, or user stop) — restore
   *  the main track. */
  onUnduck?: () => void

  /** Apple ID currently previewing, or null. */
  current(): string | null {
    return this.currentId
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private emit() {
    for (const l of this.listeners) l(this.currentId)
  }

  /** Toggle preview for a track: tapping the one that's playing stops it. */
  toggle(id: string, url: string) {
    if (this.currentId === id) { this.stop(); return }
    this.start(id, url)
  }

  private start(id: string, url: string) {
    if (!this.audio) {
      this.audio = new Audio()
      this.audio.addEventListener("ended", () => this.stop())
      this.audio.addEventListener("error", () => this.stop())
    }
    const wasPreviewing = this.currentId !== null
    this.currentId = id
    this.audio.src = url
    this.audio.currentTime = 0
    // play() must run inside the user gesture that called toggle() so iOS allows it.
    this.audio.play().catch(() => this.stop())
    if (!wasPreviewing) this.onDuck?.()
    this.emit()
  }

  stop() {
    if (this.currentId === null) return
    if (this.audio) {
      try { this.audio.pause() } catch { /* ignore */ }
      this.audio.removeAttribute("src")
      try { this.audio.load() } catch { /* ignore */ }
    }
    this.currentId = null
    this.onUnduck?.()
    this.emit()
  }
}

export const previewPlayer = new PreviewPlayer()
