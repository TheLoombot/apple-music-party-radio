/**
 * iOS audio session keepalive.
 *
 * iOS Safari suspends the audio session when no audio element is actively
 * playing. This means when a track ends and we call MusicKit's play() for
 * the next track while backgrounded, iOS blocks it ("requires user gesture").
 *
 * Fix: after the first user gesture, start a looping silent audio element.
 * iOS sees the session as continuously active and allows subsequent play()
 * calls without a new gesture — including while the tab is backgrounded.
 *
 * Must be called from a user gesture handler (e.g. "Tap to listen" button).
 */

let audio: HTMLAudioElement | null = null

function buildSilentWavUrl(): string {
  // 1-second mono 16-bit PCM WAV at 8kHz, all-zero samples (pure silence)
  const sampleRate = 8000
  const numSamples = sampleRate
  const buf = new ArrayBuffer(44 + numSamples * 2)
  const v = new DataView(buf)
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  str(0, "RIFF"); v.setUint32(4, 36 + numSamples * 2, true)
  str(8, "WAVE"); str(12, "fmt ")
  v.setUint32(16, 16, true)            // fmt chunk size
  v.setUint16(20, 1, true)             // PCM
  v.setUint16(22, 1, true)             // mono
  v.setUint32(24, sampleRate, true)    // sample rate
  v.setUint32(28, sampleRate * 2, true)// byte rate
  v.setUint16(32, 2, true)             // block align
  v.setUint16(34, 16, true)            // bits per sample
  str(36, "data"); v.setUint32(40, numSamples * 2, true)
  // samples are already zeroed — no data to write
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }))
}

export function startAudioSession(): void {
  if (audio) return
  audio = new Audio(buildSilentWavUrl())
  audio.loop = true
  audio.play().catch(() => {
    // Will fail if called outside a user gesture — caller is responsible
    // for only calling this from a gesture handler.
    audio = null
  })
}

// Resume the silent element if iOS paused it while backgrounded.
// Call this on visibilitychange when tab becomes visible.
export function resumeAudioSession(): void {
  if (!audio || !audio.paused) return
  audio.play().catch(() => {})
}
