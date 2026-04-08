import { useEffect, useRef, useState } from "react"
import { Trash2, X } from "lucide-react"
import type { Station } from "../types"
import { DJFace } from "./FaceGenerator"
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

/** Overlapping row of up to `max` listener faces, then a "+N" overflow badge. */
function ListenerFaces({ listeners, max = 4 }: { listeners: NonNullable<Station["listeners"]>; max?: number }) {
  const shown = listeners.slice(0, max)
  const overflow = listeners.length - max

  if (shown.length === 0) return null

  const size = 22
  const overlap = 8
  const step = size - overlap
  const totalWidth = size + (shown.length - 1) * step + (overflow > 0 ? step : 0)

  return (
    <div className="flex items-center flex-shrink-0" style={{ width: totalWidth }}>
      {shown.map((l, i) => (
        <div
          key={l.userId}
          className="relative group rounded-lg ring-2 ring-panel flex-shrink-0"
          style={{ marginLeft: i === 0 ? 0 : -overlap, zIndex: shown.length - i }}
        >
          <DJFace uid={l.userId} size={size} />
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-1 bg-surface border border-border rounded-lg whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50 text-xs text-white">
            {l.displayName}
          </div>
        </div>
      ))}
      {overflow > 0 && (
        <div
          className="rounded-lg ring-2 ring-panel bg-surface flex items-center justify-center flex-shrink-0"
          style={{ width: size, height: size, marginLeft: -overlap, zIndex: 0 }}
        >
          <span className="text-[9px] text-muted font-medium">+{overflow}</span>
        </div>
      )}
    </div>
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
  const listeners = station.listeners ?? []
  const spunBy = station.nowPlayingAddedBy
  const isRobot = spunBy === "robot"

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={e => e.key === "Enter" && onSelect()}
        className={`group w-full text-left flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 transition-colors cursor-pointer ${active ? "bg-accent/10" : ""}`}
      >
        {isLive && station.nowPlayingArtworkUrl ? (
          <div className="w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
            <img src={artworkUrl(station.nowPlayingArtworkUrl, 192)} alt="" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="w-24 h-24 rounded flex-shrink-0 bg-surface/50 flex items-center justify-center text-muted/30 text-sm">♪</div>
        )}
        <div className="flex-1 min-w-0">
          <p className={`text-sm truncate ${active ? "text-accent" : "text-white"}`}>
            {station.displayName || station.id}
          </p>
          {isLive && station.nowPlayingTrackName ? (
            <p className="text-xs text-muted truncate mt-0.5">
              {station.nowPlayingArtistName && `${station.nowPlayingArtistName} — `}{station.nowPlayingTrackName}
            </p>
          ) : !isLive ? (
            <p className="text-xs text-muted/40 mt-0.5">offline</p>
          ) : null}
          {listeners.length > 0 && (
            <div className="mt-2">
              <ListenerFaces listeners={listeners} />
            </div>
          )}
        </div>

        {isLive && (
          <div className="flex flex-col items-center gap-1 flex-shrink-0 pt-0.5">
            {isRobot ? (
              <span className="text-2xl leading-none opacity-40">🤖</span>
            ) : spunBy ? (
              <DJFace uid={spunBy} size={64} />
            ) : null}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted/70 truncate max-w-[56px]">
                {isRobot ? "robot" : spunBy === userId ? userDisplayName : station.nowPlayingAddedByName ?? ""}
              </span>
              <LiveDot />
            </div>
          </div>
        )}

        <button
          onClick={e => { e.stopPropagation(); onRemove() }}
          className="opacity-0 group-hover:opacity-100 text-muted hover:text-red-400 transition-all flex-shrink-0 pt-1"
          title="Remove station"
        >
          <Trash2 size={13} />
        </button>
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
  const [moreOpen, setMoreOpen] = useState(false)

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

  const liveStations = stations
    .filter(s => s.liveUntil > now)
    .sort((a, b) => a.id.localeCompare(b.id))
  const allStations = [...stations].sort((a, b) => a.id.localeCompare(b.id))
  const offlineCount = stations.filter(s => s.liveUntil <= now).length

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider">
        Stations
      </div>

      {stations.length === 0 ? (
        <div className="p-6 text-center text-muted text-sm">No stations yet</div>
      ) : liveStations.length === 0 ? (
        <div className="p-6 text-center text-muted text-sm">No live stations right now</div>
      ) : (
        <ul>
          {liveStations.map(station => (
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
          ))}
        </ul>
      )}

      <div className="flex border-t border-border/50">
        {offlineCount > 0 && (
          <button
            onClick={() => setMoreOpen(true)}
            className="flex-1 px-4 py-2.5 text-xs text-muted hover:text-white transition-colors text-left"
          >
            All stations ({stations.length})
          </button>
        )}
        <button
          onClick={onCreateStation}
          className="flex-1 px-4 py-2.5 text-xs text-muted hover:text-accent transition-colors text-left"
        >
          + Create a station
        </button>
      </div>

      {moreOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80"
          onClick={() => setMoreOpen(false)}
        >
          <div
            className="bg-panel rounded-2xl w-full max-w-sm overflow-hidden"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <span className="text-xs text-muted font-medium uppercase tracking-wider">All Stations</span>
              <button onClick={() => setMoreOpen(false)} className="text-muted hover:text-white transition-colors">
                <X size={16} />
              </button>
            </div>
            <ul className="max-h-[60vh] overflow-y-auto">
              {allStations.map(station => (
                <StationRow
                  key={station.id}
                  station={station}
                  active={station.id === currentStationId}
                  isOwn={ownedStationIds.includes(station.id)}
                  userId={userId}
                  userDisplayName={userDisplayName}
                  now={now}
                  onSelect={() => { onSelect(station.id); setMoreOpen(false) }}
                  onRemove={() => onRemove(station.id)}
                />
              ))}
            </ul>
            <div className="border-t border-border/50">
              <button
                onClick={() => { onCreateStation(); setMoreOpen(false) }}
                className="w-full px-4 py-2.5 text-xs text-muted hover:text-accent transition-colors text-left"
              >
                + Create a station
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
