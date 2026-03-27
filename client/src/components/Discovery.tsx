import { useEffect, useState, useRef } from "react"
import { ChevronRight } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { TrackRow } from "./TrackRow"
import type { MusicCatalog } from "../services/catalog"
import type { Track, PlaylistResult } from "../types"

type Tab = "charts" | "mfy"

function pickRandom<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n)
}

interface Props {
  catalog: MusicCatalog
  queuedIsrcs: Set<string>
  onAddTrack: (track: Track) => void
}

export function Discovery({ catalog, queuedIsrcs, onAddTrack }: Props) {
  const [tab, setTab] = useState<Tab>("charts")

  const allChartTracks = useRef<Track[]>([])
  const [chartTracks, setChartTracks] = useState<Track[]>([])
  const [chartsLoading, setChartsLoading] = useState(true)

  const allPlaylists = useRef<PlaylistResult[]>([])
  const [playlists, setPlaylists] = useState<PlaylistResult[]>([])
  const [mfyLoading, setMfyLoading] = useState(true)
  const [browsing, setBrowsing] = useState<{ playlist: PlaylistResult; tracks: Track[] | null } | null>(null)

  useEffect(() => {
    catalog.getChartSongs().then(tracks => {
      allChartTracks.current = tracks
      setChartTracks(pickRandom(tracks, 3))
      setChartsLoading(false)
    })
    catalog.getRecommendedPlaylists().then(p => {
      allPlaylists.current = p
      setPlaylists(pickRandom(p, 3))
      setMfyLoading(false)
    })
  }, [catalog])

  const refreshCharts = () => setChartTracks(pickRandom(allChartTracks.current, 3))
  const refreshMfy = () => { setBrowsing(null); setPlaylists(pickRandom(allPlaylists.current, 3)) }

  const handleSelectPlaylist = async (playlist: PlaylistResult) => {
    setBrowsing({ playlist, tracks: null })
    const tracks = await catalog.getPlaylistTracks(playlist.id)
    setBrowsing({ playlist, tracks })
  }

  const loading = tab === "charts" ? chartsLoading : mfyLoading

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      {/* Header */}
      <div className="border-b border-border">
        {tab === "mfy" && browsing ? (
          <div className="px-4 py-3 text-xs text-muted font-medium uppercase tracking-wider flex items-center gap-2">
            <button onClick={() => setBrowsing(null)} className="text-accent hover:text-white transition-colors">
              ← Made for You
            </button>
            <span className="text-border">·</span>
            <span className="text-white normal-case font-normal truncate">{browsing.playlist.name}</span>
          </div>
        ) : (
          <div className="flex items-center">
            {(["charts", "mfy"] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setBrowsing(null) }}
                className={`flex-1 px-4 py-3 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  tab === t ? "text-white border-accent" : "text-muted hover:text-white border-transparent"
                }`}
              >
                {t === "charts" ? "Charts" : "Made for You"}
              </button>
            ))}
            <button
              onClick={tab === "charts" ? refreshCharts : refreshMfy}
              className="px-4 py-3 text-muted hover:text-white transition-colors"
              title="Shuffle"
            >
              ↻
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      {loading ? (
        <div className="p-6 text-center text-muted text-sm animate-pulse">Loading…</div>
      ) : tab === "charts" ? (
        chartTracks.length === 0 ? (
          <div className="p-6 text-center text-muted text-sm">No chart data available</div>
        ) : (
          <ul>
            {chartTracks.map(track => (
              <TrackRow
                key={track.platformIds.apple ?? track.isrc}
                track={track}
                added={queuedIsrcs.has(track.isrc)}
                onAdd={() => onAddTrack(track)}
              />
            ))}
          </ul>
        )
      ) : browsing ? (
        browsing.tracks === null ? (
          <div className="p-6 text-center text-muted text-sm animate-pulse">Loading tracks…</div>
        ) : browsing.tracks.length === 0 ? (
          <div className="p-6 text-center text-muted text-sm">No tracks found</div>
        ) : (
          <ul>
            {browsing.tracks.map(track => (
              <TrackRow
                key={track.platformIds.apple ?? track.isrc}
                track={track}
                added={queuedIsrcs.has(track.isrc)}
                onAdd={() => onAddTrack(track)}
              />
            ))}
          </ul>
        )
      ) : playlists.length === 0 ? (
        <div className="p-6 text-center text-muted text-sm">No recommendations available</div>
      ) : (
        <ul>
          {playlists.map(playlist => (
            <li key={playlist.id}>
              <div
                role="button"
                tabIndex={0}
                onClick={() => handleSelectPlaylist(playlist)}
                onKeyDown={e => e.key === "Enter" && handleSelectPlaylist(playlist)}
                className="flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 transition-colors cursor-pointer"
              >
                <div className="w-10 h-10 rounded flex-shrink-0 overflow-hidden bg-surface">
                  {playlist.artworkUrl
                    ? <img src={artworkUrl(playlist.artworkUrl, 40)} alt="" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center text-muted text-sm">♫</div>}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-white text-sm truncate">{playlist.name}</p>
                  {playlist.subtitle && <p className="text-muted text-xs truncate">{playlist.subtitle}</p>}
                </div>
                <ChevronRight size={14} className="text-muted flex-shrink-0" />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
