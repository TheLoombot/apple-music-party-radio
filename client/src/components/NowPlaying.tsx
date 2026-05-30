import { useState, useEffect, useCallback, useRef } from "react"
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

function SoundBars({ active }: { active: boolean }) {
  return (
    <div className="flex items-end gap-0.5 h-6">
      {BAR_DELAYS.map((delay, i) => (
        <div
          key={i}
          className="sound-bar w-1.5"
          style={{
            height: "100%",
            animationDelay: delay,
            animationDuration: BAR_DURATIONS[i],
            background: active
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

// ── 7-segment LED display ────────────────────────────────────────────────────

const DIG_W = 22
const DIG_H = 40
const T = 3.2
const DIG_GAP = 5
const DOT_W = 5
const SEG_ON = "#ff9800"
const SEG_OFF = "rgba(255,152,0,0.15)"

const SEGS: [number, number, number, number][] = [
  [T, 0, DIG_W - 2 * T, T],
  [DIG_W - T, T, T, DIG_H / 2 - 2 * T],
  [DIG_W - T, DIG_H / 2 + T, T, DIG_H / 2 - 2 * T],
  [T, DIG_H - T, DIG_W - 2 * T, T],
  [0, DIG_H / 2 + T, T, DIG_H / 2 - 2 * T],
  [0, T, T, DIG_H / 2 - 2 * T],
  [T, DIG_H / 2 - T / 2, DIG_W - 2 * T, T],
]

const DIGIT_SEGS: Record<string, number[]> = {
  "0": [1, 1, 1, 1, 1, 1, 0],
  "1": [0, 1, 1, 0, 0, 0, 0],
  "2": [1, 1, 0, 1, 1, 0, 1],
  "3": [1, 1, 1, 1, 0, 0, 1],
  "4": [0, 1, 1, 0, 0, 1, 1],
  "5": [1, 0, 1, 1, 0, 1, 1],
  "6": [1, 0, 1, 1, 1, 1, 1],
  "7": [1, 1, 1, 0, 0, 0, 0],
  "8": [1, 1, 1, 1, 1, 1, 1],
  "9": [1, 1, 1, 1, 0, 1, 1],
}

function SegChar({ ch }: { ch: string }) {
  const segs = DIGIT_SEGS[ch] ?? Array(7).fill(0)
  return (
    <svg width={DIG_W} height={DIG_H} viewBox={`0 0 ${DIG_W} ${DIG_H}`} style={{ overflow: "visible" }}>
      {SEGS.map(([x, y, w, h], i) => (
        <rect key={i} x={x} y={y} width={w} height={h} fill={segs[i] ? SEG_ON : SEG_OFF} rx={0.8} />
      ))}
    </svg>
  )
}

function SegDot() {
  return (
    <svg width={DOT_W} height={DIG_H} viewBox={`0 0 ${DOT_W} ${DIG_H}`}>
      <rect x={0} y={DIG_H - DOT_W} width={DOT_W} height={DOT_W} fill={SEG_ON} rx={0.8} />
    </svg>
  )
}

function SevenSegDisplay({ value }: { value: string }) {
  const chars = value.padStart(5, " ").split("")
  return (
    <div
      className="flex items-end select-none"
      style={{ gap: `${DIG_GAP}px`, filter: `drop-shadow(0 0 6px ${SEG_ON}) drop-shadow(0 0 14px ${SEG_ON})` }}
    >
      {chars.map((ch, i) => ch === "." ? <SegDot key={i} /> : <SegChar key={i} ch={ch} />)}
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
  const [freqInput, setFreqInput] = useState("")
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
    setFreqInput(frequency?.toFixed(1) ?? "")
    setInfoOpen(true)
  }, [stationName, frequency])

  const handleSave = useCallback(() => {
    const name = nameInput.trim() || stationName
    const parsed = parseFloat(freqInput)
    const freq = isNaN(parsed)
      ? (frequency ?? 88.0)
      : Math.round(Math.max(66.6, Math.min(109.9, parsed)) * 10) / 10
    onRenameStation?.(name, freq)
    setInfoOpen(false)
  }, [nameInput, freqInput, stationName, frequency, onRenameStation])
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
         * Name centered, info pinned to the right. Name still opens the station modal. */}
        <div className="relative px-3 pt-3 pb-2 flex items-center justify-center min-h-[28px]">
          <button
            onClick={onOpenStationModal}
            className="text-white text-base font-bold hover:text-accent transition-colors max-w-[calc(100%-3rem)] truncate"
          >
            {stationName}
          </button>
          <button
            onClick={openInfo}
            className="absolute right-3 text-muted/40 hover:text-white/70 transition-colors w-7 h-7 flex items-center justify-center"
            title="Station info"
          >
            <Info size={14} />
          </button>
        </div>

        {/* Frequency + nav row — laid out on a 4-column grid so it aligns
         * with the Mute/Chat row below and the Skip/Ban/Pool/+ row in the
         * bottom panel. Prev=col1, LED=col2-3, Next=col4. */}
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
          {/* LED display spans the middle two columns, matching Ban+Pool width below */}
          <div className="col-span-2 h-12 rounded-lg border border-white/10 bg-black/40 flex items-center justify-center">
            <SevenSegDisplay value={displayFreq != null ? displayFreq.toFixed(1) : ""} />
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
                <SoundBars active={!quiet} />
                {quiet
                  ? <VolumeX size={20} className="shimmer-text" />
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

            {/* Controls */}
            <div className="grid grid-cols-4 gap-2 px-4 pb-5">
              <Tooltip label={canSkip ? "Skip" : "DJs only"} align="start">
                <button
                  onClick={onSkip}
                  disabled={!canSkip}
                  aria-label="Skip"
                  className="btn-3d w-full h-12 rounded-lg flex items-center justify-center text-white"
                >
                  <SkipForward size={20} />
                </button>
              </Tooltip>
              <Tooltip label={!canSkip ? "DJs only" : "Skip & remove from pool"}>
                <button
                  onClick={onSkipAndBan}
                  disabled={!canSkip || !onSkipAndBan}
                  aria-label="Skip and remove from pool"
                  className="btn-3d w-full h-12 rounded-lg flex items-center justify-center text-white hover:text-red-400"
                >
                  <Ban size={20} />
                </button>
              </Tooltip>
              <Tooltip label={onOpenPool ? "Open pool" : "DJs only"}>
                <button
                  onClick={onOpenPool}
                  disabled={!onOpenPool}
                  aria-label="Open pool"
                  className="btn-3d w-full h-12 rounded-lg flex items-center justify-center text-white"
                >
                  <Library size={20} />
                </button>
              </Tooltip>
              {onOpenAddTracks && (
                <Tooltip label={addButtonLabel ?? "Add tracks"} align="end">
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
            className="p-8 text-center text-muted"
          >
            <div className="text-4xl mb-3">📻</div>
            <p className="text-sm">Station is quiet.</p>
            <p className="text-xs mt-1">Add a track to get it started.</p>
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
                {isOwner && onRenameStation ? (
                  <input
                    type="text"
                    inputMode="decimal"
                    value={freqInput}
                    onChange={e => setFreqInput(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") setInfoOpen(false) }}
                    placeholder="88.0"
                    className="w-full bg-surface text-white rounded-lg px-3 py-2 text-sm font-mono outline-none focus:ring-1 focus:ring-accent"
                  />
                ) : (
                  <p className="text-white text-sm font-mono">{frequency?.toFixed(1)}</p>
                )}
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
