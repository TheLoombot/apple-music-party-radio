import { useState, useEffect, useLayoutEffect, useCallback, useRef } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Volume2, VolumeX, SkipForward, Library, Info, Rewind, FastForward, Ban, MessageCircle, Plus } from "lucide-react"
import { Tooltip } from "./Tooltip"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
import { ArtworkModal } from "./ArtworkModal"
import { ArtworkFlip } from "./ArtworkFlip"
import { DJFace, RobotFace } from "./FaceGenerator"
import type { QueueItem, AppUser } from "../types"
import type { MusicCatalog } from "../services/catalog"

// Feature flag — flip back to `true` to surface the "spun by <user>" attribution
// line under the track info. The data (track.addedBy / addedByName) still
// arrives from the server, this only controls the UI rendering.
const SHOW_SPUN_BY = false

/** Mobile = below Tailwind's sm breakpoint (640px). Used to choose between
 *  the inline album-art flip (mobile) and the enlarging ArtworkModal (desktop). */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 639px)").matches
  )
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)")
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener("change", handler)
    return () => mq.removeEventListener("change", handler)
  }, [])
  return isMobile
}

interface Props {
  track: QueueItem | null
  stationOwner: string
  currentUser: AppUser
  canSkip: boolean
  onSkip: () => void
  onSkipAndBan?: () => void
  onMuteToggle: () => void
  isMuted: boolean
  isBlocked: boolean
  onResume: () => void
  onAlbumClick?: () => void
  onOpenPool?: () => void
  catalog?: MusicCatalog
  stationName: string
  isOwner: boolean
  ownerName?: string
  onRenameStation?: (name: string, frequency: number) => void
  onOpenStationModal?: () => void
  activeStationCount?: number
  frequency?: number
  onPrevStation?: () => void
  onNextStation?: () => void
  /** True between switching/joining a station and receiving its first queue snapshot.
   *  Lets us distinguish "haven't heard from the server yet" from "confirmed empty queue". */
  loading?: boolean
  onOpenChat?: () => void
  unreadCount?: number
  onOpenAddTracks?: () => void
  addButtonLabel?: string
  /** Shown as a red badge on the + button — e.g. number of pending suggestions. */
  addBadgeCount?: number
  djNotes?: Record<string, string>
  onSaveDjNote?: (itemId: string, note: string) => void
}

function useProgress(track: QueueItem | null) {
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!track) { setProgress(0); setElapsed(0); return }

    function tick() {
      const startTime = track!.expirationTime - track!.durationMs
      const elapsedMs = Math.min(Date.now() - startTime, track!.durationMs)
      setElapsed(Math.max(0, elapsedMs))
      setProgress(Math.max(0, Math.min(1, elapsedMs / track!.durationMs)))
    }

    tick()
    let id = setInterval(tick, 1000)

    function onVisibilityChange() {
      if (document.hidden) return
      // Tab just became visible. Browser throttles setInterval to ~1 min while
      // hidden — snap immediately to the correct position then restart fresh.
      clearInterval(id)
      tick()
      id = setInterval(tick, 1000)
    }

    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [track?.key])

  return { progress, elapsed }
}

const BAR_DELAYS = ["0s", "0.15s", "0.3s", "0.45s"]
const BAR_DURATIONS = ["0.7s", "0.9s", "0.75s", "0.85s"]

function SoundBars({ playing, muted }: { playing: boolean; muted: boolean }) {
  // Three visual states:
  //   playing && !muted → animated, full color gradient
  //   playing && muted  → animated, gray (audio's there, just silenced)
  //   !playing          → static short nubs, gray (nothing playing)
  return (
    <div className="flex items-end gap-0.5 h-6">
      {BAR_DELAYS.map((delay, i) => (
        <div
          key={i}
          className={`w-1.5 ${playing ? "sound-bar" : ""}`}
          style={{
            height: "100%",
            animationDelay: playing ? delay : undefined,
            animationDuration: playing ? BAR_DURATIONS[i] : undefined,
            clipPath: playing ? undefined : "inset(80% 0 0 0 round 2px)",
            background: playing && !muted
              ? "linear-gradient(to top, #22c55e 0%, #eab308 60%, #fc3c44 100%)"
              : "rgba(255,255,255,0.2)",
          }}
        />
      ))}
    </div>
  )
}

function useMediaSession(
  track: QueueItem | null,
  isPlaying: boolean,
  canSkip: boolean,
  onSkip: () => void,
  onPlay: () => void,
  onPause: () => void,
  onPrevStation: (() => void) | undefined,
  onNextStation: (() => void) | undefined,
) {
  useEffect(() => {
    if (!("mediaSession" in navigator)) return

    if (!track) {
      navigator.mediaSession.metadata = null
      navigator.mediaSession.playbackState = "none"
      try { navigator.mediaSession.setPositionState() } catch {}
      navigator.mediaSession.setActionHandler("play", null)
      navigator.mediaSession.setActionHandler("pause", null)
      navigator.mediaSession.setActionHandler("nexttrack", null)
      navigator.mediaSession.setActionHandler("previoustrack", null)
      navigator.mediaSession.setActionHandler("seekto", null)
      navigator.mediaSession.setActionHandler("seekbackward", null)
      navigator.mediaSession.setActionHandler("seekforward", null)
      return
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.name,
      artist: track.artistName,
      album: track.albumName,
      artwork: track.artworkUrl
        ? [{ src: artworkUrl(track.artworkUrl, 512), sizes: "512x512", type: "image/jpeg" }]
        : [],
    })

    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused"

    const startTime = track.expirationTime - track.durationMs
    const position = Math.max(0, Math.min(track.durationMs / 1000, (Date.now() - startTime) / 1000))
    try {
      navigator.mediaSession.setPositionState({
        duration: track.durationMs / 1000,
        playbackRate: isPlaying ? 1 : 0,
        position,
      })
    } catch {}

    navigator.mediaSession.setActionHandler("play", onPlay)
    navigator.mediaSession.setActionHandler("pause", onPause)
    // prev/next station takes priority over skip when multiple stations are available
    navigator.mediaSession.setActionHandler("previoustrack", onPrevStation ?? null)
    navigator.mediaSession.setActionHandler("nexttrack", onNextStation ?? (canSkip ? onSkip : null))
    navigator.mediaSession.setActionHandler("seekto", () => {})
    navigator.mediaSession.setActionHandler("seekbackward", () => {})
    navigator.mediaSession.setActionHandler("seekforward", () => {})
  }, [track?.key, isPlaying, canSkip, onSkip, onPlay, onPause, onPrevStation, onNextStation])
}

// ── LED display constants — shared by the frequency and station-name displays.

const DIG_W = 22
const DIG_H = 40
const T = 3.2
const DIG_GAP = 5
const DOT_W = 5
const SEG_ON = "#ff9800"
const SEG_OFF = "rgba(255,152,0,0.15)"

function SegDot() {
  return (
    <svg width={DOT_W} height={DIG_H} viewBox={`0 0 ${DOT_W} ${DIG_H}`}>
      <rect x={0} y={DIG_H - DOT_W} width={DOT_W} height={DOT_W} fill={SEG_ON} rx={0.8} />
    </svg>
  )
}

// Frequency LED — uses the same 14-seg glyphs as the station name so the
// whole panel reads as one continuous instrument. Decimal point is SegDot.
function SevenSegDisplay({ value }: { value: string }) {
  const chars = value.padStart(5, " ").split("")
  return (
    <div className="flex items-end select-none" style={{ gap: `${DIG_GAP}px` }}>
      {chars.map((ch, i) => ch === "." ? <SegDot key={i} /> : <FsChar key={i} ch={ch} />)}
    </div>
  )
}

// ── 14-segment LED — for the station name. Same physical scale (DIG_W/DIG_H/T)
//    as the 7-seg frequency display so they read as one continuous instrument.

// Axis-aligned segments. Order is fixed: A B C D E F G1 G2 I L (rectangles).
// The four diagonals (H J K M) follow as polygons.
const FS_RECTS: [number, number, number, number][] = [
  [T, 0, DIG_W - 2*T, T],                                          // A: top
  [DIG_W - T, T, T, DIG_H/2 - 3*T/2],                              // B: top-right
  [DIG_W - T, DIG_H/2 + T/2, T, DIG_H/2 - 3*T/2],                  // C: bottom-right
  [T, DIG_H - T, DIG_W - 2*T, T],                                  // D: bottom
  [0, DIG_H/2 + T/2, T, DIG_H/2 - 3*T/2],                          // E: bottom-left
  [0, T, T, DIG_H/2 - 3*T/2],                                      // F: top-left
  [T, DIG_H/2 - T/2, DIG_W/2 - 3*T/2, T],                          // G1: middle-left
  [DIG_W/2 + T/2, DIG_H/2 - T/2, DIG_W/2 - 3*T/2, T],              // G2: middle-right
  [DIG_W/2 - T/2, T, T, DIG_H/2 - 3*T/2],                          // I: top-center
  [DIG_W/2 - T/2, DIG_H/2 + T/2, T, DIG_H/2 - 3*T/2],              // L: bottom-center
]

// Diagonals end short of the exact center so they don't overlap the mid-bar
// and center verticals — same approach as real 14-seg displays.
const FS_DIAGS: [number, number, number, number][] = [
  [T + 0.5, T + 0.5, DIG_W/2 - T, DIG_H/2 - T],                    // H: NW (TL → near center)
  [DIG_W - T - 0.5, T + 0.5, DIG_W/2 + T, DIG_H/2 - T],            // J: NE
  [DIG_W/2 + T, DIG_H/2 + T, DIG_W - T - 0.5, DIG_H - T - 0.5],    // K: SE (near center → BR)
  [DIG_W/2 - T, DIG_H/2 + T, T + 0.5, DIG_H - T - 0.5],            // M: SW (near center → BL)
]

function fsDiagPoly(x1: number, y1: number, x2: number, y2: number, t: number): string {
  // Parallelogram slab of thickness t, perpendicular to the (x1,y1)→(x2,y2) line.
  const dx = x2 - x1, dy = y2 - y1
  const len = Math.hypot(dx, dy)
  const px = -dy / len * t * 0.5
  const py =  dx / len * t * 0.5
  return `${x1+px},${y1+py} ${x1-px},${y1-py} ${x2-px},${y2-py} ${x2+px},${y2+py}`
}

// Character → 14 segments. Order matches FS_RECTS then FS_DIAGS:
// [A, B, C, D, E, F, G1, G2, I, L, H, J, K, M]
const FS_CHARS: Record<string, number[]> = {
  " ": [0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "-": [0,0,0,0,0,0,1,1,0,0,0,0,0,0],
  "0": [1,1,1,1,1,1,0,0,0,0,0,0,0,0],
  "1": [0,1,1,0,0,0,0,0,0,0,0,0,0,0],
  "2": [1,1,0,1,1,0,1,1,0,0,0,0,0,0],
  "3": [1,1,1,1,0,0,0,1,0,0,0,0,0,0],
  "4": [0,1,1,0,0,1,1,1,0,0,0,0,0,0],
  "5": [1,0,1,1,0,1,1,1,0,0,0,0,0,0],
  "6": [1,0,1,1,1,1,1,1,0,0,0,0,0,0],
  "7": [1,1,1,0,0,0,0,0,0,0,0,0,0,0],
  "8": [1,1,1,1,1,1,1,1,0,0,0,0,0,0],
  "9": [1,1,1,1,0,1,1,1,0,0,0,0,0,0],
  "A": [1,1,1,0,1,1,1,1,0,0,0,0,0,0],
  "B": [1,1,1,1,0,0,0,1,1,1,0,0,0,0],
  "C": [1,0,0,1,1,1,0,0,0,0,0,0,0,0],
  "D": [1,1,1,1,0,0,0,0,1,1,0,0,0,0],
  "E": [1,0,0,1,1,1,1,1,0,0,0,0,0,0],
  "F": [1,0,0,0,1,1,1,1,0,0,0,0,0,0],
  "G": [1,0,1,1,1,1,0,1,0,0,0,0,0,0],
  "H": [0,1,1,0,1,1,1,1,0,0,0,0,0,0],
  "I": [1,0,0,1,0,0,0,0,1,1,0,0,0,0],
  "J": [0,1,1,1,0,0,0,0,0,0,0,0,0,0],
  // K: left spine (E+F), middle-left bar (G1), arm up to TR (J), leg down to BR (K segment).
  "K": [0,0,0,0,1,1,1,0,0,0,0,1,1,0],
  "L": [0,0,0,1,1,1,0,0,0,0,0,0,0,0],
  "M": [0,1,1,0,1,1,0,0,0,0,1,1,0,0],
  "N": [0,1,1,0,1,1,0,0,0,0,1,0,1,0],
  "O": [1,1,1,1,1,1,0,0,0,0,0,0,0,0],
  "P": [1,1,0,0,1,1,1,1,0,0,0,0,0,0],
  "Q": [1,1,1,1,1,1,0,0,0,0,0,0,1,0],
  "R": [1,1,0,0,1,1,1,1,0,0,0,0,1,0],
  "S": [1,0,1,1,0,1,1,1,0,0,0,0,0,0],
  "T": [1,0,0,0,0,0,0,0,1,1,0,0,0,0],
  "U": [0,1,1,1,1,1,0,0,0,0,0,0,0,0],
  "V": [0,0,0,0,1,1,0,0,0,0,0,1,0,1],
  "W": [0,1,1,0,1,1,0,0,0,0,0,0,1,1],
  "X": [0,0,0,0,0,0,0,0,0,0,1,1,1,1],
  "Y": [0,0,0,0,0,0,0,0,0,1,1,1,0,0],
  "Z": [1,0,0,1,0,0,0,0,0,0,0,1,0,1],
}

function FsChar({ ch }: { ch: string }) {
  const segs = FS_CHARS[ch.toUpperCase()] ?? FS_CHARS[" "]
  return (
    <svg width={DIG_W} height={DIG_H} viewBox={`0 0 ${DIG_W} ${DIG_H}`}>
      {FS_RECTS.map(([x, y, w, h], i) => (
        <rect key={`r${i}`} x={x} y={y} width={w} height={h} fill={segs[i] ? SEG_ON : SEG_OFF} rx={0.8} />
      ))}
      {FS_DIAGS.map(([x1, y1, x2, y2], i) => (
        <polygon
          key={`d${i}`}
          points={fsDiagPoly(x1, y1, x2, y2, T)}
          fill={segs[10 + i] ? SEG_ON : SEG_OFF}
        />
      ))}
    </svg>
  )
}

// FourteenSegDisplay: like a physical LED marquee sign. A fixed grid of N
// character slots stays put; the lit segments shift one position at a time
// to scroll the message. Empty slots show all-off (the "ghost" LEDs).
// Number of slots is derived from container width via ResizeObserver.
function FourteenSegDisplay({ value }: { value: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState(8)

  useLayoutEffect(() => {
    const update = () => {
      const c = containerRef.current
      if (!c) return
      // N glyphs occupy N*DIG_W + (N-1)*DIG_GAP px → solve for max N that fits.
      const n = Math.max(1, Math.floor((c.clientWidth + DIG_GAP) / (DIG_W + DIG_GAP)))
      setSlots(n)
    }
    update()
    const ro = new ResizeObserver(update)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const message = value.toUpperCase()
  const fits = message.length <= slots

  // Discrete tick-based scroll. The padded period is `message + (slots) blanks`,
  // chosen so the display goes fully blank for exactly one frame between the
  // prior iteration scrolling off the left edge and the next iteration scrolling
  // in from the right edge. Never two iterations on screen at once.
  const period = Math.max(1, message.length + slots)
  const [offset, setOffset] = useState(0)
  useEffect(() => {
    setOffset(0)
    if (fits) return
    // One-time initial pause so the start of the name is readable before it
    // scrolls left. Subsequent cycles scroll through continuously.
    const INITIAL_PAUSE_TICKS = 4
    let holding = INITIAL_PAUSE_TICKS
    const id = setInterval(() => {
      if (holding > 0) { holding--; return }
      setOffset(prev => (prev + 1) % period)
    }, 280)
    return () => clearInterval(id)
  }, [fits, period])

  const visible: string[] = []
  if (fits) {
    // Center the message within the slot grid.
    const leftPad = Math.floor((slots - message.length) / 2)
    for (let i = 0; i < slots; i++) {
      if (i >= leftPad && i < leftPad + message.length) visible.push(message[i - leftPad])
      else visible.push(" ")
    }
  } else {
    for (let i = 0; i < slots; i++) {
      const idx = (offset + i) % period
      visible.push(idx < message.length ? message[idx] : " ")
    }
  }

  return (
    <div
      ref={containerRef}
      className="w-full flex items-end justify-center select-none"
      style={{ gap: `${DIG_GAP}px` }}
    >
      {visible.map((ch, i) => <FsChar key={i} ch={ch} />)}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function useFrequencyScan(frequency: number | undefined) {
  const [displayFreq, setDisplayFreq] = useState<number | null>(frequency ?? null)
  const prevFreqRef = useRef<number | null>(frequency ?? null)
  const scanRef = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => {
    clearInterval(scanRef.current)
    const from = prevFreqRef.current
    const to = frequency ?? null
    prevFreqRef.current = to

    if (from === null || to === null || from === to) {
      setDisplayFreq(to)
      return
    }

    const FRAMES = 22
    const STEP_MS = 22
    const steps: number[] = []
    for (let i = 1; i <= FRAMES; i++) {
      steps.push(Math.round((from + (to - from) * (i / FRAMES)) * 10) / 10)
    }

    let i = 0
    scanRef.current = setInterval(() => {
      setDisplayFreq(steps[i])
      i++
      if (i >= steps.length) clearInterval(scanRef.current)
    }, STEP_MS)

    return () => clearInterval(scanRef.current)
  }, [frequency])

  return displayFreq
}

export function NowPlaying({ track, stationOwner, currentUser, canSkip, onSkip, onSkipAndBan, isMuted, onMuteToggle, isBlocked, onResume, onAlbumClick, onOpenPool, catalog, stationName, isOwner, ownerName, onRenameStation, onOpenStationModal, activeStationCount, frequency, onPrevStation, onNextStation, loading, onOpenChat, unreadCount, onOpenAddTracks, addButtonLabel, addBadgeCount, djNotes, onSaveDjNote }: Props) {
  const isMobile = useIsMobile()
  const { progress, elapsed } = useProgress(track)
  const isPlaying = !isMuted && !isBlocked
  const quiet = isMuted || isBlocked
  const [artworkOpen, setArtworkOpen] = useState(false)
  const closeArtwork = useCallback(() => setArtworkOpen(false), [])
  const [infoOpen, setInfoOpen] = useState(false)
  const [nameInput, setNameInput] = useState("")
  const [navBusy, setNavBusy] = useState(false)
  const navCooldownRef = useRef<ReturnType<typeof setTimeout>>()
  const displayFreq = useFrequencyScan(frequency)

  const handlePrevNav = useCallback(() => {
    if (navBusy || !onPrevStation) return
    setNavBusy(true)
    onPrevStation()
    navCooldownRef.current = setTimeout(() => setNavBusy(false), 1000)
  }, [navBusy, onPrevStation])

  const handleNextNav = useCallback(() => {
    if (navBusy || !onNextStation) return
    setNavBusy(true)
    onNextStation()
    navCooldownRef.current = setTimeout(() => setNavBusy(false), 1000)
  }, [navBusy, onNextStation])

  useEffect(() => () => clearTimeout(navCooldownRef.current), [])

  const openInfo = useCallback(() => {
    setNameInput(stationName)
    setInfoOpen(true)
  }, [stationName])

  const handleSave = useCallback(() => {
    const name = nameInput.trim() || stationName
    // Frequency is the station's permanent id — pass it through unchanged.
    onRenameStation?.(name, frequency ?? 0)
    setInfoOpen(false)
  }, [nameInput, stationName, frequency, onRenameStation])
  useMediaSession(
    track,
    isPlaying,
    canSkip,
    onSkip,
    isBlocked ? onResume : onMuteToggle,
    isBlocked ? () => {} : onMuteToggle,
    onPrevStation ? handlePrevNav : undefined,
    onNextStation ? handleNextNav : undefined,
  )

  return (
    <div className="space-y-4">
      {/* Top panel — station name / frequency / mute / chat */}
      <div className="bg-panel rounded-xl overflow-hidden">
        {/* Station name + info row — at the top of the panel.
         * 14-segment LED in the same dark-bordered container as the frequency
         * display below, so the panel reads as one continuous instrument.
         * FourteenSegDisplay scrolls character-by-character when the name
         * doesn't fit. Clickable (opens station modal) but no hover styling. */}
        <div className="px-3 pt-3 pb-2 flex items-center gap-2">
          <button
            onClick={onOpenStationModal}
            aria-label={stationName}
            title={stationName}
            className="flex-1 min-w-0"
          >
            <div className="h-12 rounded-lg border border-white/10 bg-black/40 flex items-center justify-center overflow-hidden">
              <FourteenSegDisplay value={stationName} />
            </div>
          </button>
          <button
            onClick={openInfo}
            className="text-muted/40 hover:text-white/70 transition-colors w-7 h-7 flex items-center justify-center shrink-0"
            title="Station info"
          >
            <Info size={14} />
          </button>
        </div>

        {/* Frequency + nav row — laid out on a 4-column grid so it aligns
         * with the Mute/Chat row below. Prev=col1, LED=col2-3, Next=col4. */}
        <div className="grid grid-cols-4 gap-2 px-4 pt-2 pb-2">
          <Tooltip label="Previous station" position="bottom" align="start">
            <button
              onClick={handlePrevNav}
              disabled={!onPrevStation || navBusy}
              aria-label="Previous station"
              className={`btn-3d w-full h-12 flex items-center justify-center rounded-lg
                ${!onPrevStation ? "invisible" : navBusy ? "btn-3d-pressed text-white/25 cursor-not-allowed" : "text-white/70 hover:text-white"}`}
            >
              <Rewind size={30} strokeWidth={2} fill="currentColor" stroke="none" />
            </button>
          </Tooltip>
          {/* LED display sits in the middle two columns, but the bordered
           *  box itself shrink-wraps the digits so the border hugs the LEDs
           *  with minimal black space on either side. */}
          <div className="col-span-2 flex justify-center">
            <div className="h-12 rounded-lg border border-white/10 bg-black/40 flex items-center justify-center px-1">
              <SevenSegDisplay value={displayFreq != null ? displayFreq.toFixed(1) : ""} />
            </div>
          </div>
          <Tooltip label="Next station" position="bottom" align="end">
            <button
              onClick={handleNextNav}
              disabled={!onNextStation || navBusy}
              aria-label="Next station"
              className={`btn-3d w-full h-12 flex items-center justify-center rounded-lg
                ${!onNextStation ? "invisible" : navBusy ? "btn-3d-pressed text-white/25 cursor-not-allowed" : "text-white/70 hover:text-white"}`}
            >
              <FastForward size={30} strokeWidth={2} fill="currentColor" stroke="none" />
            </button>
          </Tooltip>
        </div>

      {/* Mute + Chat — each spans two columns of the 4-col grid, so Mute
       * fills cols 1-2 and Chat fills cols 3-4 (full-width split in half). */}
      {(() => {
        const muteLabel = quiet ? (isBlocked ? "Tap to start playback" : "Unmute") : "Mute"
        return (
          <div className="grid grid-cols-4 gap-2 px-4 pt-2 pb-3">
            <Tooltip label={muteLabel} className="col-span-2" align="start">
              <button
                onClick={isBlocked ? onResume : onMuteToggle}
                aria-label={muteLabel}
                className={`btn-3d w-full h-12 rounded-lg flex items-center justify-center gap-3 ${isMuted ? "btn-3d-pressed" : ""}`}
              >
                <SoundBars playing={!!track} muted={isMuted || isBlocked} />
                {quiet
                  ? <VolumeX size={20} className="attention-pulse" />
                  : <Volume2 size={20} />}
              </button>
            </Tooltip>
            {onOpenChat && (
              <Tooltip label="Chat" className="col-span-2" align="end">
                <button
                  onClick={onOpenChat}
                  aria-label="Chat"
                  className="btn-3d relative w-full h-12 rounded-lg flex items-center justify-center text-white/80 hover:text-white"
                >
                  <MessageCircle size={20} />
                  {(unreadCount ?? 0) > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] bg-accent rounded-full text-[10px] font-bold text-white flex items-center justify-center px-1 leading-none pointer-events-none">
                      {unreadCount! > 9 ? "9+" : unreadCount}
                    </span>
                  )}
                </button>
              </Tooltip>
            )}
          </div>
        )
      })()}
      </div>{/* /top panel */}

      {/* Bottom panel — album art (or loading/empty placeholder) and below */}
      <div className="bg-panel rounded-xl overflow-hidden">
      <AnimatePresence mode="wait">
        {track ? (
          <motion.div
            key={track.key}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
          >
            {/* Full-width album art */}
            <motion.div
              key={track.isrc || track.platformIds?.apple}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
              className="w-full aspect-square bg-surface"
            >
              {track.artworkUrl ? (
                /* Mobile: tap flips the art in place to show editorial notes.
                 * Desktop: tap opens the enlarging modal (which itself can flip). */
                <ArtworkFlip
                  src={artworkUrl(track.artworkUrl, 750)}
                  alt={track.albumName}
                  catalog={catalog}
                  songId={track.platformIds?.apple}
                  albumName={track.albumName}
                  onClick={isMobile ? undefined : () => setArtworkOpen(true)}
                  outerStyle={{ width: "100%", height: "100%" }}
                  djNotes={djNotes}
                  onSaveDjNote={onSaveDjNote}
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted text-6xl">♪</div>
              )}
            </motion.div>

            {/* Progress bar + time */}
            <div className="px-4 pt-3">
              <div className="w-full h-1.5 bg-surface rounded-full overflow-hidden">
                <motion.div
                  className="h-full bg-accent rounded-full"
                  style={{ width: `${progress * 100}%` }}
                  transition={{ duration: 1, ease: "linear" }}
                />
              </div>
              <div className="flex justify-end mt-1.5">
                <span className="text-sm text-muted tabular-nums">−{formatDuration(track.durationMs - elapsed)}</span>
              </div>
            </div>

            {/* Track info */}
            <motion.div
              key={`${track.key}-info`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: 0.05 }}
              className="px-4 pt-1 pb-3"
            >
              <p className="text-muted/70 text-sm">{track.artistName}</p>
              <p className="text-white text-xl font-bold">{track.name}</p>
              {onAlbumClick
                ? <button onClick={onAlbumClick} className="text-muted/50 text-sm mt-0.5 hover:text-red-400 transition-colors text-left">{track.albumName}</button>
                : <p className="text-muted/50 text-sm mt-0.5">{track.albumName}</p>}
              {SHOW_SPUN_BY && (
                <p className="text-muted text-sm mt-2 flex items-center gap-1.5">
                  spun by{" "}
                  {track.addedBy === "robot"
                    ? <RobotFace size={20} />
                    : <DJFace uid={track.addedBy} size={20} />
                  }
                  <span className="text-white/60">
                    {track.addedBy === "robot" ? "robot"
                      : track.addedBy === currentUser.uid ? currentUser.displayName
                      : track.addedByName ?? track.addedBy}
                  </span>
                </p>
              )}
            </motion.div>

            {/* Controls — full-width Add on top, Pool/Skip/Ban below */}
            <div className="px-4 pb-5 space-y-2">
              {onOpenAddTracks && (
                <Tooltip label={addButtonLabel ?? "Add tracks"}>
                  <button
                    onClick={onOpenAddTracks}
                    aria-label={addButtonLabel ?? "Add tracks"}
                    className="btn-3d relative w-full h-12 rounded-lg flex items-center justify-center text-white"
                  >
                    <Plus size={24} strokeWidth={3} />
                    {(addBadgeCount ?? 0) > 0 && (
                      <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] bg-accent rounded-full text-[10px] font-bold text-white flex items-center justify-center px-1 leading-none pointer-events-none">
                        {addBadgeCount! > 9 ? "9+" : addBadgeCount}
                      </span>
                    )}
                  </button>
                </Tooltip>
              )}
              <div className="grid grid-cols-3 gap-2">
                <Tooltip label={onOpenPool ? "Open pool" : "DJs only"} align="start">
                  <button
                    onClick={onOpenPool}
                    disabled={!onOpenPool}
                    aria-label="Open pool"
                    className="btn-3d w-full h-12 rounded-lg flex items-center justify-center text-white"
                  >
                    <Library size={20} />
                  </button>
                </Tooltip>
                <Tooltip label={canSkip ? "Skip" : "DJs only"}>
                  <button
                    onClick={onSkip}
                    disabled={!canSkip}
                    aria-label="Skip"
                    className="btn-3d w-full h-12 rounded-lg flex items-center justify-center text-white"
                  >
                    <SkipForward size={20} />
                  </button>
                </Tooltip>
                <Tooltip label={!canSkip ? "DJs only" : "Skip & remove from pool"} align="end">
                  <button
                    onClick={onSkipAndBan}
                    disabled={!canSkip || !onSkipAndBan}
                    aria-label="Skip and remove from pool"
                    className="btn-3d w-full h-12 rounded-lg flex items-center justify-center text-white hover:text-red-400"
                  >
                    <Ban size={20} />
                  </button>
                </Tooltip>
              </div>
            </div>
          </motion.div>
        ) : loading ? (
          <motion.div
            key="loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Match the playing state's vertical footprint so switching stations
                doesn't shrink/jump the panel. The art-equivalent square holds the
                indicator; the spacer below stands in for progress + info + controls. */}
            <div className="w-full aspect-square bg-surface flex flex-col items-center justify-center text-muted gap-3">
              <div className="text-4xl">📡</div>
              <p className="text-sm">
                Tuning in<span className="loading-dot-1">.</span><span className="loading-dot-2">.</span><span className="loading-dot-3">.</span>
              </p>
            </div>
            <div className="h-[14rem]" aria-hidden />
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            {/* Art-sized placeholder */}
            <div className="w-full aspect-square bg-surface flex flex-col items-center justify-center text-muted gap-3">
              <div className="text-4xl">📻</div>
              <p className="text-sm text-center">Station is quiet.<br /><br />Add a track below to start listening.</p>
            </div>

            {/* Progress bar placeholder */}
            <div className="px-4 pt-3">
              <div className="w-full h-1.5 bg-surface rounded-full" />
              <div className="flex justify-end mt-1.5">
                <span className="text-sm tabular-nums invisible">−0:00</span>
              </div>
            </div>

            {/* Track info placeholder — invisible to preserve height */}
            <div className="px-4 pt-1 pb-3">
              <p className="text-sm invisible">artist</p>
              <p className="text-xl font-bold invisible">title</p>
              <p className="text-sm mt-0.5 invisible">album</p>
            </div>

            {/* Controls — full-width Add on top, Pool/Skip/Ban disabled below */}
            <div className="px-4 pb-5 space-y-2">
              {onOpenAddTracks && (
                <Tooltip label={addButtonLabel ?? "Add tracks"}>
                  <button
                    onClick={onOpenAddTracks}
                    aria-label={addButtonLabel ?? "Add tracks"}
                    className="btn-3d relative w-full h-12 rounded-lg flex items-center justify-center text-white"
                  >
                    {/* Queue is confirmed empty — pulse the icon to draw attention. */}
                    <Plus size={24} strokeWidth={3} className="attention-pulse" />
                    {(addBadgeCount ?? 0) > 0 && (
                      <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] bg-accent rounded-full text-[10px] font-bold text-white flex items-center justify-center px-1 leading-none pointer-events-none">
                        {addBadgeCount! > 9 ? "9+" : addBadgeCount}
                      </span>
                    )}
                  </button>
                </Tooltip>
              )}
              <div className="grid grid-cols-3 gap-2">
                <Tooltip label="DJs only" align="start">
                  <button disabled aria-label="Open pool" className="btn-3d w-full h-12 rounded-lg flex items-center justify-center text-white">
                    <Library size={20} />
                  </button>
                </Tooltip>
                <Tooltip label="DJs only">
                  <button disabled aria-label="Skip" className="btn-3d w-full h-12 rounded-lg flex items-center justify-center text-white">
                    <SkipForward size={20} />
                  </button>
                </Tooltip>
                <Tooltip label="DJs only" align="end">
                  <button disabled aria-label="Skip and remove from pool" className="btn-3d w-full h-12 rounded-lg flex items-center justify-center text-white">
                    <Ban size={20} />
                  </button>
                </Tooltip>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      </div>{/* /bottom panel */}

      <AnimatePresence>
        {artworkOpen && track?.artworkUrl && (
          <ArtworkModal
            src={artworkUrl(track.artworkUrl, 750)}
            alt={track.albumName}
            onClose={closeArtwork}
            catalog={catalog}
            songId={track.platformIds?.apple}
            albumName={track.albumName}
            djNotes={djNotes}
            onSaveDjNote={onSaveDjNote}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {infoOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6"
            onClick={() => setInfoOpen(false)}
          >
            <div className="absolute inset-0 bg-black/60" />
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 8 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 8 }}
              transition={{ duration: 0.15 }}
              className="relative bg-panel rounded-2xl p-5 w-full max-w-xs shadow-xl z-10 space-y-4"
              onClick={e => e.stopPropagation()}
            >
              <h2 className="text-white text-base font-bold text-center tracking-wide">Station Info</h2>

              <div className="space-y-1">
                <p className="text-muted/60 text-xs uppercase tracking-widest">Station Name</p>
                {isOwner && onRenameStation ? (
                  <input
                    autoFocus
                    value={nameInput}
                    onChange={e => setNameInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setInfoOpen(false) }}
                    className="w-full bg-surface text-white rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent"
                  />
                ) : (
                  <p className="text-white text-sm font-medium">{stationName}</p>
                )}
              </div>

              <div className="space-y-1">
                <p className="text-muted/60 text-xs uppercase tracking-widest">Frequency</p>
                <p className="text-white text-sm font-press-start">{frequency?.toFixed(1)}</p>
              </div>

              {ownerName && (
                <div className="space-y-1">
                  <p className="text-muted/60 text-xs uppercase tracking-widest">Owner</p>
                  <p className="text-white text-sm font-medium">{ownerName}</p>
                </div>
              )}

              {isOwner && onRenameStation ? (
                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setInfoOpen(false)}
                    className="flex-1 py-2.5 rounded-xl bg-surface text-muted text-sm font-semibold hover:text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    className="flex-1 py-2.5 rounded-xl bg-accent text-white text-sm font-bold hover:bg-accent-hover transition-colors"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setInfoOpen(false)}
                  className="w-full py-2.5 rounded-xl bg-surface text-muted text-sm font-semibold hover:text-white transition-colors"
                >
                  Close
                </button>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
