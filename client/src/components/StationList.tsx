import { useEffect, useRef, useState } from "react"
import { Trash2, X } from "lucide-react"
import type { Station } from "../types"
import { DJFace } from "./FaceGenerator"

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

  return (
    <div className="flex items-center flex-shrink-0" style={{ width: shown.length === 1 ? 28 : 28 + (shown.length - 1) * 18 + (overflow > 0 ? 18 : 0) }}>
      {shown.map((l, i) => (
        <div
          key={l.userId}
          title={l.displayName}
          className="rounded-full ring-2 ring-panel flex-shrink-0"
          style={{ marginLeft: i === 0 ? 0 : -10, zIndex: shown.length - i }}
        >
          <DJFace uid={l.userId} size={28} />
        </div>
      ))}
      {overflow > 0 && (
        <div
          className="w-7 h-7 rounded-full ring-2 ring-panel bg-surface flex items-center justify-center flex-shrink-0"
          style={{ marginLeft: -10, zIndex: 0 }}
        >
          <span className="text-[9px] text-muted font-medium">+{overflow}</span>
        </div>
      )}
    </div>
  )
}

function StationRow({
  station, active, isOwn, userId, now, onSelect, onRemove,
}: {
  station: Station
  active: boolean
  isOwn: boolean
  userId: string
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
        className={`group w-full text-left flex items-start gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 transition-colors cursor-pointer ${active ? "bg-accent/10" : ""}`}
      >
        <div className="flex-1 min-w-0">
          <p className={`text-sm truncate ${active ? "text-accent" : "text-white"}`}>
            {station.displayName}
            {isOwn && <span className="text-muted text-xs font-normal ml-1.5">(you)</span>}
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
              <div className="rounded-full ring-2 ring-accent/40">
                <DJFace uid={spunBy} size={42} />
              </div>
            ) : null}
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-muted/70 truncate max-w-[56px]">
                {isRobot ? "robot" : spunBy === userId ? "you" : station.nowPlayingAddedByName ?? ""}
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
  ownedStationIds: string[]
  onSelect: (stationId: string) => void
  onRemove: (stationId: string) => void
  onCreateStation: () => void
}

/** Sort score: human-DJ stations first, then robot/unknown live, then offline. Tiebreak by listener count. */
function sortScore(s: Station, now: number): number {
  if (s.liveUntil > now) {
    const listenerCount = s.listeners?.length ?? 0
    const hasHumanDJ = s.nowPlayingAddedBy && s.nowPlayingAddedBy !== "robot"
    return (hasHumanDJ ? 10000 : 1000) + listenerCount
  }
  return 0
}

export function StationList({ stations, currentStationId, userId, ownedStationIds, onSelect, onRemove, onCreateStation }: Props) {
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

  const sorted = [...stations].sort((a, b) => sortScore(b, now) - sortScore(a, now))

  // Sidebar: live stations + own stations + currently-tuned station
  const sidebarStations = sorted.filter(s =>
    s.liveUntil > now || s.id === currentStationId || ownedStationIds.includes(s.id)
  )
  const hiddenCount = sorted.filter(s =>
    s.liveUntil <= now && s.id !== currentStationId && !ownedStationIds.includes(s.id)
  ).length

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider">
        Stations
      </div>

      {stations.length === 0 ? (
        <div className="p-6 text-center text-muted text-sm">No stations yet</div>
      ) : (
        <ul>
          {sidebarStations.map(station => (
            <StationRow
              key={station.id}
              station={station}
              active={station.id === currentStationId}
              isOwn={ownedStationIds.includes(station.id)}
              userId={userId}
              now={now}
              onSelect={() => onSelect(station.id)}
              onRemove={() => onRemove(station.id)}
            />
          ))}
        </ul>
      )}

      {hiddenCount > 0 && (
        <button
          onClick={() => setMoreOpen(true)}
          className="w-full px-4 py-2.5 text-xs text-muted hover:text-white transition-colors border-t border-border/50"
        >
          More stations ({hiddenCount})
        </button>
      )}

      <button
        onClick={onCreateStation}
        className="w-full px-4 py-2.5 text-xs text-muted hover:text-accent transition-colors border-t border-border/50 text-left"
      >
        + Create a station
      </button>

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
              {sorted.map(station => (
                <StationRow
                  key={station.id}
                  station={station}
                  active={station.id === currentStationId}
                  isOwn={ownedStationIds.includes(station.id)}
                  userId={userId}
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
