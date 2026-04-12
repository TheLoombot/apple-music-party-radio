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
        {/* Album art thumbnail */}
        <div className="relative group/art w-12 h-12 flex-shrink-0">
          <div className="w-full h-full rounded overflow-hidden bg-surface/50">
            {isLive && station.nowPlayingArtworkUrl
              ? <img src={artworkUrl(station.nowPlayingArtworkUrl, 80)} alt="" className="w-full h-full object-cover" />
              : <div className="w-full h-full flex items-center justify-center text-muted/20 text-xs">♪</div>
            }
          </div>
          {isLive && station.nowPlayingTrackName && (
            <div className="absolute bottom-full left-0 mb-1.5 px-2 py-1 bg-surface border border-border rounded-lg whitespace-nowrap opacity-0 pointer-events-none group-hover/art:opacity-100 transition-opacity z-50 text-xs text-white max-w-[200px]">
              {station.nowPlayingArtistName && <p className="text-muted/70 truncate">{station.nowPlayingArtistName}</p>}
              <p className="truncate">{station.nowPlayingTrackName}</p>
            </div>
          )}
        </div>

        {/* Station name */}
        <div className="flex-1 min-w-0">
          <p className={`text-sm truncate flex items-center gap-1 ${active ? "text-accent" : isLive ? "text-white" : "text-white/50"}`}>
            {isOwn && <Mic size={10} className="flex-shrink-0 text-muted/40" />}
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
                <div className="absolute bottom-full right-0 mb-1.5 px-2 py-1 bg-surface border border-border rounded-lg whitespace-nowrap opacity-0 pointer-events-none group-hover/dj:opacity-100 transition-opacity z-50 text-xs text-white">
                  {isRobot ? "robot" : spunBy === userId ? userDisplayName : station.nowPlayingAddedByName ?? spunBy}
                </div>
              )}
            </div>
            <LiveDot />
          </div>
        )}

        {/* Trash — always reserve space to prevent layout shift */}
        <div className="flex-shrink-0 w-3">
          {isOwn && (
            <button
              onClick={e => { e.stopPropagation(); onRemove() }}
              className="opacity-0 group-hover:opacity-100 text-muted hover:text-red-400 transition-all"
              title="Remove station"
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
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

  const yourStations = stations
    .filter(s => ownedStationIds.includes(s.id))
    .sort((a, b) => a.id.localeCompare(b.id))

  const otherStations = stations
    .filter(s => !ownedStationIds.includes(s.id))
    .sort((a, b) => {
      // live first, then alphabetical
      if (a.liveUntil > now && b.liveUntil <= now) return -1
      if (a.liveUntil <= now && b.liveUntil > now) return 1
      return a.id.localeCompare(b.id)
    })

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
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider flex-shrink-0">
        Stations
      </div>

      {stations.length === 0 ? (
        <div className="p-6 text-center text-muted text-sm">No stations yet</div>
      ) : (
        <div>
          {yourStations.length > 0 && (
            <>
              <div className="px-4 pt-3 pb-1 text-[10px] text-muted/50 font-medium uppercase tracking-wider">
                Your stations
              </div>
              <ul>{yourStations.map(s => renderRow(s))}</ul>
            </>
          )}
          {otherStations.length > 0 && (
            <>
              {yourStations.length > 0 && (
                <div className="px-4 pt-3 pb-1 text-[10px] text-muted/50 font-medium uppercase tracking-wider">
                  All stations
                </div>
              )}
              <ul>{otherStations.map(s => renderRow(s))}</ul>
            </>
          )}
        </div>
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
