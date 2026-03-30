import { useEffect, useState, useRef } from "react"
import { ChevronRight } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { TrackRow } from "./TrackRow"
import type { MusicCatalog } from "../services/catalog"
import type { Track, PlaylistResult, QueueItem } from "../types"

type Tab = "charts" | "mfy" | "related"

function pickRandom<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n)
}

interface Props {
  catalog: MusicCatalog
  queuedIsrcs: Set<string>
  queue: QueueItem[]
  onAddTrack: (track: Track) => void
}

export function Discovery({ catalog, queuedIsrcs, queue, onAddTrack }: Props) {
  const [tab, setTab] = useState<Tab>("charts")

  const allChartTracks = useRef<Track[]>([])
  const [chartTracks, setChartTracks] = useState<Track[]>([])
  const [chartsLoading, setChartsLoading] = useState(true)

  const allPlaylists = useRef<PlaylistResult[]>([])
  const [playlists, setPlaylists] = useState<PlaylistResult[]>([])
  const [mfyLoading, setMfyLoading] = useState(true)
  const [browsing, setBrowsing] = useState<{ playlist: PlaylistResult; tracks: Track[] | null } | null>(null)

  // Related tab state
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [relatedTracks, setRelatedTracks] = useState<Track[]>([])
  const [relatedSeed, setRelatedSeed] = useState<{ name: string; artistName: string } | null>(null)
  const [relatedPlaylist, setRelatedPlaylist] = useState<PlaylistResult | null>(null)
  const [relatedError, setRelatedError] = useState(false)
  const allRelatedPlaylists = useRef<PlaylistResult[]>([])

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

  async function loadRelated(forceNew = false) {
    const candidates = queue.filter(t => t.platformIds?.apple)
    if (candidates.length === 0) { setRelatedError(true); return }

    const seed = candidates[Math.floor(Math.random() * candidates.length)]
    setRelatedSeed({ name: seed.name, artistName: seed.artistName })
    setRelatedLoading(true)
    setRelatedError(false)
    setRelatedTracks([])

    try {
      // Fetch (or reuse) the appears-on playlists for this seed track
      if (forceNew || allRelatedPlaylists.current.length === 0) {
        const pls = await catalog.getRelatedPlaylists(seed.platformIds.apple!)
        allRelatedPlaylists.current = pls
      }
      if (allRelatedPlaylists.current.length === 0) { setRelatedError(true); return }

      const playlist = pickRandom(allRelatedPlaylists.current, 1)[0]
      setRelatedPlaylist(playlist)
      const tracks = await catalog.getPlaylistTracks(playlist.id)
      setRelatedTracks(pickRandom(tracks, 3))
    } catch {
      setRelatedError(true)
    } finally {
      setRelatedLoading(false)
    }
  }

  const refreshRelated = () => {
    allRelatedPlaylists.current = []
    loadRelated(true)
  }

  // Load related tab on first switch to it
  const relatedLoadedRef = useRef(false)
  const handleTabChange = (t: Tab) => {
    setTab(t)
    setBrowsing(null)
    if (t === "related" && !relatedLoadedRef.current) {
      relatedLoadedRef.current = true
      loadRelated(true)
    }
  }

  const TAB_LABELS: Record<Tab, string> = { charts: "Charts", mfy: "Made for You", related: "Related" }

  const isBrowsing = (tab === "mfy" || tab === "related") && browsing

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      {/* Header */}
      <div className="border-b border-border">
        {isBrowsing ? (
          <div className="px-4 py-3 text-xs text-muted font-medium uppercase tracking-wider flex items-center gap-2">
            <button onClick={() => setBrowsing(null)} className="text-accent hover:text-white transition-colors">
              ← {TAB_LABELS[tab]}
            </button>
            <span className="text-border">·</span>
            <span className="text-white normal-case font-normal truncate">{browsing.playlist.name}</span>
          </div>
        ) : (
          <div className="flex items-center">
            {(["charts", "mfy", "related"] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => handleTabChange(t)}
                className={`flex-1 px-3 py-3 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  tab === t ? "text-white border-accent" : "text-muted hover:text-white border-transparent"
                }`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
            <button
              onClick={tab === "charts" ? refreshCharts : tab === "mfy" ? refreshMfy : refreshRelated}
              className="px-4 py-3 text-muted hover:text-white transition-colors"
              title="Shuffle"
            >
              ↻
            </button>
          </div>
        )}
      </div>

      {/* Content */}
      {tab === "charts" ? (
        chartsLoading ? (
          <div className="p-6 text-center text-muted text-sm animate-pulse">Loading…</div>
        ) : chartTracks.length === 0 ? (
          <div className="p-6 text-center text-muted text-sm">No chart data available</div>
        ) : (
          <ul>
            {chartTracks.map(track => (
              <TrackRow
                key={track.platformIds?.apple ?? track.isrc}
                track={track}
                added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                onAdd={() => onAddTrack(track)}
              />
            ))}
          </ul>
        )
      ) : tab === "mfy" ? (
        isBrowsing ? (
          <>
            <div className="flex items-center gap-4 px-4 py-4 border-b border-border bg-surface/40">
              <div className="w-16 h-16 rounded-lg flex-shrink-0 overflow-hidden bg-surface shadow-md">
                {browsing!.playlist.artworkUrl
                  ? <img src={artworkUrl(browsing!.playlist.artworkUrl, 64)} alt="" className="w-full h-full object-cover" />
                  : <div className="w-full h-full flex items-center justify-center text-muted text-xl">♫</div>}
              </div>
              <div className="min-w-0">
                <p className="text-white text-base font-bold truncate">{browsing!.playlist.name}</p>
                {browsing!.playlist.subtitle && <p className="text-muted text-sm truncate mt-0.5">{browsing!.playlist.subtitle}</p>}
              </div>
            </div>
            {browsing!.tracks === null ? (
              <div className="p-6 text-center text-muted text-sm animate-pulse">Loading tracks…</div>
            ) : browsing!.tracks.length === 0 ? (
              <div className="p-6 text-center text-muted text-sm">No tracks found</div>
            ) : (
              <ul>
                {browsing!.tracks.map(track => (
                  <TrackRow
                    key={track.platformIds?.apple ?? track.isrc}
                    track={track}
                    added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                    onAdd={() => onAddTrack(track)}
                  />
                ))}
              </ul>
            )}
          </>
        ) : mfyLoading ? (
          <div className="p-6 text-center text-muted text-sm animate-pulse">Loading…</div>
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
        )
      ) : /* related tab */ (
        isBrowsing ? (
          <>
            <div className="flex items-center gap-4 px-4 py-4 border-b border-border bg-surface/40">
              <div className="w-16 h-16 rounded-lg flex-shrink-0 overflow-hidden bg-surface shadow-md">
                {browsing!.playlist.artworkUrl
                  ? <img src={artworkUrl(browsing!.playlist.artworkUrl, 64)} alt="" className="w-full h-full object-cover" />
                  : <div className="w-full h-full flex items-center justify-center text-muted text-xl">♫</div>}
              </div>
              <div className="min-w-0">
                <p className="text-white text-base font-bold truncate">{browsing!.playlist.name}</p>
                {browsing!.playlist.subtitle && <p className="text-muted text-sm truncate mt-0.5">{browsing!.playlist.subtitle}</p>}
              </div>
            </div>
            {browsing!.tracks === null ? (
              <div className="p-6 text-center text-muted text-sm animate-pulse">Loading tracks…</div>
            ) : browsing!.tracks.length === 0 ? (
              <div className="p-6 text-center text-muted text-sm">No tracks found</div>
            ) : (
              <ul>
                {browsing!.tracks.map(track => (
                  <TrackRow
                    key={track.platformIds?.apple ?? track.isrc}
                    track={track}
                    added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                    onAdd={() => onAddTrack(track)}
                  />
                ))}
              </ul>
            )}
          </>
        ) : relatedLoading ? (
          <div className="p-6 text-center text-muted text-sm animate-pulse">Finding related tracks…</div>
        ) : relatedError || relatedTracks.length === 0 ? (
          <div className="p-6 text-center text-muted text-sm">
            {queue.length === 0
              ? "Add tracks to the queue to get related suggestions."
              : "No related playlists found. Try shuffling ↻"}
          </div>
        ) : (
          <>
            {(relatedSeed || relatedPlaylist) && (
              <div className="px-4 py-2.5 border-b border-border/50 text-xs text-muted space-y-0.5">
                {relatedSeed && (
                  <p className="truncate">
                    <span className="text-muted/60">track  </span>
                    <span className="text-white/70">{relatedSeed.name}</span>
                    <span className="text-muted/40"> · {relatedSeed.artistName}</span>
                  </p>
                )}
                {relatedPlaylist && (
                  <p className="truncate">
                    <span className="text-muted/60">playlist  </span>
                    <span className="text-white/70">{relatedPlaylist.name}</span>
                    {relatedPlaylist.subtitle && <span className="text-muted/40"> · {relatedPlaylist.subtitle}</span>}
                  </p>
                )}
              </div>
            )}
            <ul>
              {relatedTracks.map(track => (
                <TrackRow
                  key={track.platformIds?.apple ?? track.isrc}
                  track={track}
                  added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                  onAdd={() => onAddTrack(track)}
                />
              ))}
            </ul>
          </>
        )
      )}
    </div>
  )
}
