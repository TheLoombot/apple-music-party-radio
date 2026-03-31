import { useEffect, useRef, useState } from "react"
import { Trash2 } from "lucide-react"
import type { Station } from "../types"

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

interface Props {
  stations: Station[]
  currentStationId: string
  ownStationId: string
  onSelect: (stationId: string) => void
  onRemove: (stationId: string) => void
}

export function StationList({ stations, currentStationId, ownStationId, onSelect, onRemove }: Props) {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const next = stations
      .map(s => s.liveUntil)
      .filter(t => t > Date.now())
      .sort((a, b) => a - b)[0]
    if (!next) return
    const timer = setTimeout(() => setNow(Date.now()), next - Date.now() + 200)
    return () => clearTimeout(timer)
  }, [stations])

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider">
        Stations
      </div>

      {stations.length === 0 ? (
        <div className="p-6 text-center text-muted text-sm">No stations yet</div>
      ) : (
        <ul>
          {stations.map(station => {
            const active = station.id === currentStationId
            const isOwn = station.id === ownStationId
            return (
              <li key={station.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(station.id)}
                  onKeyDown={e => e.key === "Enter" && onSelect(station.id)}
                  className={`group w-full text-left flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 transition-colors cursor-pointer ${active ? "bg-accent/10" : ""}`}
                >
                  <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-sm text-accent font-bold flex-shrink-0">
                    {station.displayName?.[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${active ? "text-accent" : "text-white"}`}>
                      {station.displayName}
                      {isOwn && <span className="text-muted text-xs font-normal ml-1.5">(you)</span>}
                    </p>
                    {station.liveUntil > now && station.nowPlayingTrackName && (
                      <p className="text-xs text-muted truncate mt-0.5">
                        {station.nowPlayingArtistName && `${station.nowPlayingArtistName} — `}{station.nowPlayingTrackName}
                      </p>
                    )}
                    {station.listeners && station.listeners.length > 0 && (
                      <p className="text-xs text-muted truncate mt-0.5">
                        {station.listeners.map(l => l.displayName).join(", ")}
                      </p>
                    )}
                  </div>
                  {station.liveUntil > now && (
                    <span className="flex items-center gap-1.5 text-xs text-accent flex-shrink-0">
                      <LiveDot />
                      <span>
                        {station.nowPlayingAddedBy
                          ? station.nowPlayingAddedBy === "robot"
                            ? "🤖"
                            : station.nowPlayingAddedBy === ownStationId
                            ? "you"
                            : station.nowPlayingAddedBy
                          : "live"}
                      </span>
                    </span>
                  )}
                  <button
                    onClick={e => { e.stopPropagation(); onRemove(station.id) }}
                    className="opacity-0 group-hover:opacity-100 text-muted hover:text-red-400 transition-all flex-shrink-0"
                    title="Remove station"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
