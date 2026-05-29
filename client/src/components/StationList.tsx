import { useEffect, useRef, useState } from "react"
import { Trash2, Mic } from "lucide-react"
import type { Station } from "../types"
import { DJFace, RobotFace } from "./FaceGenerator"
import { artworkUrl } from "../services/musickit"

function LiveDot() {
  const pingRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const ping = pingRef.current
    if (!ping) return
    const anim = ping.animate(
      [{ transform: "scale(1)", opacity: 0.6 }, { transform: "scale(2.5)", opacity: 0 }],
      { duration: 1200, iterations: Infinity, easing: "cubic-bezier(0, 0, 0.2, 1)" }
    )
    return () => anim.cancel()
  }, [])
  return (
    <span className="relative inline-flex w-2 h-2">
      <span ref={pingRef} className="absolute inline-flex w-full h-full rounded-full bg-accent" />
      <span className="relative inline-flex w-2 h-2 rounded-full bg-accent" />
    </span>
  )
}


function StationRow({
  station, active, isOwn, userId, userDisplayName, now, onSelect, onRemove,
}: {
  station: Station
  active: boolean
  isOwn: boolean
  userId: string
  userDisplayName: string
  now: number
  onSelect: () => void
  onRemove: () => void
}) {
  const isLive = station.liveUntil > now
  const spunBy = station.nowPlayingAddedBy
  const isRobot = spunBy === "robot"

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={e => e.key === "Enter" && onSelect()}
        className={`group w-full text-left flex items-center gap-2.5 px-3 py-2.5 border-b border-border/50 last:border-0 hover:bg-surface/50 transition-colors cursor-pointer ${active ? "bg-accent/10" : ""}`}
      >
        {/* Owned/DJ-access indicator — fixed-width slot so alignment is
         * consistent whether or not the icon shows. No glow. */}
        <div className="w-4 flex-shrink-0 flex items-center justify-center" aria-hidden={!isOwn}>
          {isOwn && (
            <span title="You DJ here" className="text-amber-400/80">
              <Mic size={14} strokeWidth={2.5} />
            </span>
          )}
        </div>

        {/* Album art thumbnail */}
        <div className="relative group/art w-[60px] h-[60px] flex-shrink-0">
          <div className="w-full h-full rounded overflow-hidden bg-surface/50">
            {isLive && station.nowPlayingArtworkUrl
              ? <img src={artworkUrl(station.nowPlayingArtworkUrl, 120)} alt="" className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center text-muted/20 text-xs">♪</div>
            }
          </div>
          {isLive && station.nowPlayingTrackName && (
            <div className="absolute top-full left-0 mt-1.5 px-2 py-1 bg-surface border border-border rounded-lg whitespace-nowrap opacity-0 pointer-events-none group-hover/art:opacity-100 transition-opacity z-50 text-xs text-white max-w-[200px]">
              {station.nowPlayingArtistName && <p className="text-muted/70 truncate">{station.nowPlayingArtistName}</p>}
              <p className="truncate">{station.nowPlayingTrackName}</p>
            </div>
          )}
        </div>

        {/* Frequency + station name */}
        <div className="flex-1 min-w-0">
          {station.frequency != null && (
            <p className={`text-base font-mono font-bold truncate ${active ? "text-accent" : isLive ? "text-white" : "text-white/50"}`}>
              {station.frequency.toFixed(1)}
            </p>
          )}
          <p className={`text-xs truncate ${active ? "text-accent/70" : isLive ? "text-white/50" : "text-white/30"}`}>
            {station.displayName || station.id}
          </p>
        </div>

        {/* Right side: DJ face + live dot, or nothing when offline */}
        {isLive && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <div className="relative group/dj">
              {isRobot
                ? <RobotFace size={28} />
                : spunBy
                ? <DJFace uid={spunBy} size={28} />
                : null}
              {(isRobot || spunBy) && (
                <div className="absolute top-full right-0 mt-1.5 px-2 py-1 bg-surface border border-border rounded-lg whitespace-nowrap opacity-0 pointer-events-none group-hover/dj:opacity-100 transition-opacity z-50 text-xs text-white">
                  {isRobot ? "robot" : spunBy === userId ? userDisplayName : station.nowPlayingAddedByName ?? spunBy}
                </div>
              )}
            </div>
            <LiveDot />
          </div>
        )}

        {isOwn ? (
          <button
            onClick={e => { e.stopPropagation(); onRemove() }}
            className="w-9 h-9 flex items-center justify-center text-muted/40 hover:text-red-400 transition-colors flex-shrink-0"
            title="Remove station"
          >
            <Trash2 size={14} />
          </button>
        ) : (
          /* Placeholder keeps the right cluster (DJ face + live dot) aligned
           * across all rows whether or not the user owns the station. */
          <div className="w-9 h-9 flex-shrink-0" aria-hidden />
        )}
      </div>
    </li>
  )
}

interface Props {
  stations: Station[]
  currentStationId: string
  userId: string
  userDisplayName: string
  ownedStationIds: string[]
  onSelect: (stationId: string) => void
  onRemove: (stationId: string) => void
  onCreateStation: () => void
}

export function StationList({ stations, currentStationId, userId, userDisplayName, ownedStationIds, onSelect, onRemove, onCreateStation }: Props) {
  const [now, setNow] = useState(Date.now())

  // Re-render just after the next track expires so live/offline status flips automatically
  useEffect(() => {
    const next = stations
      .map(s => s.liveUntil)
      .filter(t => t > Date.now())
      .sort((a, b) => a - b)[0]
    if (!next) return
    const timer = setTimeout(() => setNow(Date.now()), next - Date.now() + 200)
    return () => clearTimeout(timer)
  }, [stations])

  // Single flat list, strictly by frequency. Ownership is signalled inline
  // by the amber Mic icon next to the frequency, not by sectioning.
  const sortedStations = [...stations].sort(
    (a, b) => (a.frequency ?? 0) - (b.frequency ?? 0)
  )

  const renderRow = (station: Station) => (
    <StationRow
      key={station.id}
      station={station}
      active={station.id === currentStationId}
      isOwn={ownedStationIds.includes(station.id)}
      userId={userId}
      userDisplayName={userDisplayName}
      now={now}
      onSelect={() => onSelect(station.id)}
      onRemove={() => onRemove(station.id)}
    />
  )

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      {sortedStations.length === 0 ? (
        <div className="p-6 text-center text-muted text-sm">No stations yet</div>
      ) : (
        <ul>{sortedStations.map(s => renderRow(s))}</ul>
      )}

      <div className="border-t border-border/50">
        <button
          onClick={onCreateStation}
          className="w-full px-4 py-2.5 text-xs text-muted hover:text-accent transition-colors text-left"
        >
          + Create a station
        </button>
      </div>
    </div>
  )
}
