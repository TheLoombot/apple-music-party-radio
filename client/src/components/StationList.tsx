import { useEffect, useRef } from "react"
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
  onSelect: (stationId: string) => void
}

export function StationList({ stations, currentStationId, onSelect }: Props) {
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
            return (
              <li key={station.id}>
                <button
                  onClick={() => onSelect(station.id)}
                  className={`w-full text-left flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 transition-colors ${active ? "bg-accent/10" : ""}`}
                >
                  <div className="w-8 h-8 rounded-full bg-accent/20 flex items-center justify-center text-sm text-accent font-bold flex-shrink-0">
                    {station.displayName?.[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm truncate ${active ? "text-accent" : "text-white"}`}>
                      {station.displayName}
                    </p>
                  </div>
                  {active && (
                    <span className="flex items-center gap-1.5 text-xs text-accent flex-shrink-0">
                      <LiveDot /> live
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
