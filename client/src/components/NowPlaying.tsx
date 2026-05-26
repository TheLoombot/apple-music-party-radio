import { useState, useEffect, useCallback, useRef } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { Volume2, VolumeX, SkipForward, Library, Info, ChevronDown, Rewind, FastForward, Ban } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
import { ArtworkModal } from "./ArtworkModal"
import { DJFace, RobotFace } from "./FaceGenerator"
import type { QueueItem, AppUser } from "../types"
import type { MusicCatalog } from "../services/catalog"

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

export function NowPlaying({ track, stationOwner, currentUser, canSkip, onSkip, onSkipAndBan, isMuted, onMuteToggle, isBlocked, onResume, onAlbumClick, onOpenPool, catalog, stationName, isOwner, ownerName, onRenameStation, onOpenStationModal, activeStationCount, frequency, onPrevStation, onNextStation }: Props) {
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
    <div className="bg-panel rounded-xl overflow-hidden">
      <div className="border-b border-border">
        {/* Station name row */}
        <div className="px-3 pt-2.5 pb-1 relative flex items-center justify-center min-h-[32px]">
          <button
            onClick={onOpenStationModal}
            className="text-white text-base font-bold hover:text-accent transition-colors flex items-center gap-1 max-w-[calc(100%-2.5rem)]"
          >
            <span className="truncate">{stationName}</span>
            {(activeStationCount ?? 0) > 0 && (
              <span className="text-muted/50 text-xs font-normal flex-shrink-0">+{activeStationCount}</span>
            )}
            <ChevronDown size={11} className="flex-shrink-0 text-muted/40" />
          </button>
          <button
            onClick={openInfo}
            className="absolute right-3 text-muted/40 hover:text-white/70 transition-colors w-7 h-7 flex items-center justify-center"
            title="Station info"
          >
            <Info size={14} />
          </button>
        </div>

        {/* Frequency + nav row */}
        <div className="flex items-center px-1 pb-3 pt-1">
          <button
            onClick={handlePrevNav}
            disabled={!onPrevStation || navBusy}
            className={`w-14 h-12 flex items-center justify-center rounded-lg flex-shrink-0 transition-all
              border border-white/10 bg-surface
              shadow-[0_3px_0_rgba(0,0,0,0.5)]
              active:shadow-none active:translate-y-[3px]
              ${!onPrevStation ? "invisible" : navBusy ? "text-white/25 cursor-not-allowed shadow-none translate-y-[3px]" : "text-white/70 hover:text-white hover:border-white/20"}`}
            title="Previous station"
          >
            <Rewind size={30} strokeWidth={2} fill="currentColor" stroke="none" />
          </button>
          <div className="flex-1 flex items-center justify-center">
            {displayFreq != null
              ? <SevenSegDisplay value={displayFreq.toFixed(1)} />
              : <span className="text-white/40 text-sm font-medium truncate px-2">{stationName}</span>
            }
          </div>
          <button
            onClick={handleNextNav}
            disabled={!onNextStation || navBusy}
            className={`w-14 h-12 flex items-center justify-center rounded-lg flex-shrink-0 transition-all
              border border-white/10 bg-surface
              shadow-[0_3px_0_rgba(0,0,0,0.5)]
              active:shadow-none active:translate-y-[3px]
              ${!onNextStation ? "invisible" : navBusy ? "text-white/25 cursor-not-allowed shadow-none translate-y-[3px]" : "text-white/70 hover:text-white hover:border-white/20"}`}
            title="Next station"
          >
            <FastForward size={30} strokeWidth={2} fill="currentColor" stroke="none" />
          </button>
        </div>
      </div>

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
                <button onClick={() => setArtworkOpen(true)} className="block w-full h-full cursor-zoom-in">
                  <img src={artworkUrl(track.artworkUrl, 400)} alt={track.albumName} className="w-full h-full object-cover" />
                </button>
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
            </motion.div>

            {/* Controls */}
            <div className="flex gap-2 px-4 pb-4">
              <div className="flex-1 flex items-center justify-center py-3 rounded-xl bg-surface">
                <SoundBars active={!quiet} />
              </div>
              <button
                onClick={isBlocked ? onResume : onMuteToggle}
                className="flex-1 py-3 rounded-xl bg-surface font-bold text-base tracking-wide transition-all hover:text-red-400 flex items-center justify-center gap-2"
              >
                {quiet ? (
                  <>
                    <VolumeX size={18} className="shimmer-text" />
                    <span className="shimmer-text">UNMUTE</span>
                  </>
                ) : (
                  <>
                    <Volume2 size={18} />
                    <span>MUTE</span>
                  </>
                )}
              </button>
              {canSkip && (
                <button
                  onClick={onSkip}
                  className="flex-1 py-3 rounded-xl bg-surface font-bold text-base tracking-wide text-white transition-all hover:text-red-400 flex items-center justify-center gap-2"
                >
                  <SkipForward size={18} />
                  <span>SKIP</span>
                </button>
              )}
              {canSkip && onSkipAndBan && (
                <button
                  onClick={onSkipAndBan}
                  className="flex-1 py-3 rounded-xl bg-surface font-bold text-base tracking-wide text-white transition-all hover:text-red-400 flex items-center justify-center gap-2"
                  title="Skip and remove from pool"
                >
                  <Ban size={18} />
                  <span>BAN</span>
                </button>
              )}
              {onOpenPool && (
                <button
                  onClick={onOpenPool}
                  className="flex-1 py-3 rounded-xl bg-surface font-bold text-base tracking-wide text-white transition-all hover:text-red-400 flex items-center justify-center gap-2"
                >
                  <Library size={18} />
                  <span>POOL</span>
                </button>
              )}
            </div>
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

      <AnimatePresence>
        {artworkOpen && track?.artworkUrl && (
          <ArtworkModal
            src={artworkUrl(track.artworkUrl, 750)}
            alt={track.albumName}
            onClose={closeArtwork}
            catalog={catalog}
            songId={track.platformIds?.apple}
            albumName={track.albumName}
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
