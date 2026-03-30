import { useEffect, useState, useRef, useCallback } from "react"
import { ChevronRight, ListMusic } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { TrackRow } from "./TrackRow"
import type { MusicCatalog } from "../services/catalog"
import type { Track, PlaylistResult, LibraryPlaylistResult, AlbumResult, QueueItem } from "../types"

type Tab = "related" | "charts" | "mfy" | "playlists"

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
  const [tab, setTab] = useState<Tab>("related")

  const [chartTracks, setChartTracks] = useState<Track[]>([])
  const [chartsLoading, setChartsLoading] = useState(true)

  const allPlaylists = useRef<(PlaylistResult | AlbumResult)[]>([])
  const [playlists, setPlaylists] = useState<(PlaylistResult | AlbumResult)[]>([])
  const [mfyLoading, setMfyLoading] = useState(true)

  const [browsing, setBrowsing] = useState<{ playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult; tracks: Track[] | null } | null>(null)

  // Related tab state
  const [relatedLoading, setRelatedLoading] = useState(false)
  const [relatedTracks, setRelatedTracks] = useState<Track[]>([])
  const [relatedSeed, setRelatedSeed] = useState<{ name: string; artistName: string } | null>(null)
  const [relatedPlaylist, setRelatedPlaylist] = useState<PlaylistResult | null>(null)
  const [relatedError, setRelatedError] = useState(false)
  const allRelatedPlaylists = useRef<PlaylistResult[]>([])

  // Playlists tab state
  const [libraryPlaylists, setLibraryPlaylists] = useState<LibraryPlaylistResult[] | null>(null)
  const [loadingLibrary, setLoadingLibrary] = useState(false)
  const [playlistFilter, setPlaylistFilter] = useState("")
  const playlistScrollRef = useRef<HTMLDivElement>(null)
  const savedPlaylistScroll = useRef(0)

  useEffect(() => {
    catalog.getCharts().then(c => {
      setChartTracks(c[0]?.tracks ?? [])
      setChartsLoading(false)
    })
    catalog.getRecommendedPlaylists().then(p => {
      allPlaylists.current = p
      setPlaylists(pickRandom(p, 3))
      setMfyLoading(false)
    })
  }, [catalog])

  const refreshMfy = () => { setBrowsing(null); setPlaylists(pickRandom(allPlaylists.current, 3)) }

  const handleSelectPlaylist = async (playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult) => {
    if (playlist.kind === "library-playlist") {
      savedPlaylistScroll.current = playlistScrollRef.current?.scrollTop ?? 0
    }
    setBrowsing({ playlist, tracks: null })
    const tracks = playlist.kind === "library-playlist"
      ? await catalog.getLibraryPlaylistTracks(playlist.id)
      : playlist.kind === "album"
      ? await catalog.getAlbumTracks(playlist.id)
      : await catalog.getPlaylistTracks(playlist.id)
    setBrowsing({ playlist, tracks })
  }

  const handleBack = useCallback(() => {
    const wasLibrary = browsing?.playlist.kind === "library-playlist"
    setBrowsing(null)
    if (wasLibrary) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (playlistScrollRef.current) playlistScrollRef.current.scrollTop = savedPlaylistScroll.current
        })
      })
    }
  }, [browsing])

  async function loadRelated(forceNew = false) {
    const candidates = queue.filter(t => t.platformIds?.apple)
    if (candidates.length === 0) { setRelatedError(true); return }

    const seed = candidates[Math.floor(Math.random() * candidates.length)]
    setRelatedSeed({ name: seed.name, artistName: seed.artistName })
    setRelatedLoading(true)
    setRelatedError(false)
    setRelatedTracks([])

    try {
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

  // Reload Related whenever the queue content changes (debounced)
  const relatedLoadedRef = useRef(false)
  const relatedDebounceRef = useRef<ReturnType<typeof setTimeout>>()
  const queueKey = queue.map(t => t.platformIds?.apple ?? t.isrc ?? t.key).join(",")
  useEffect(() => {
    if (tab !== "related" || queue.length === 0) return
    clearTimeout(relatedDebounceRef.current)
    relatedDebounceRef.current = setTimeout(() => {
      relatedLoadedRef.current = true
      allRelatedPlaylists.current = []
      loadRelated(true)
    }, relatedLoadedRef.current ? 2000 : 0)
    return () => clearTimeout(relatedDebounceRef.current)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueKey, tab])

  const handleTabChange = (t: Tab) => {
    setTab(t)
    setBrowsing(null)
    if (t === "related" && !relatedLoadedRef.current && queue.length > 0) {
      relatedLoadedRef.current = true
      allRelatedPlaylists.current = []
      loadRelated(true)
    }
    if (t === "playlists" && libraryPlaylists === null && !loadingLibrary) {
      setLoadingLibrary(true)
      catalog.getLibraryPlaylists().then(p => {
        setLibraryPlaylists(p)
        setLoadingLibrary(false)
      })
    }
  }

  const TAB_LABELS: Record<Tab, string> = { related: "Related", charts: "Top 20", mfy: "Top Picks for You", playlists: "Your Playlists" }

  const isBrowsing = (tab === "mfy" || tab === "related" || tab === "playlists") && browsing

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      {/* Header */}
      <div className="border-b border-border">
        {isBrowsing ? (
          <div className="px-4 py-3 text-xs text-muted font-medium uppercase tracking-wider flex items-center gap-2">
            <button onClick={handleBack} className="text-accent hover:text-white transition-colors">
              ← {TAB_LABELS[tab]}
            </button>
            <span className="text-border">·</span>
            <span className="text-white normal-case font-normal truncate">{browsing!.playlist.name}</span>
          </div>
        ) : (
          <div className="flex items-center">
            {(["related", "charts", "mfy", "playlists"] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => handleTabChange(t)}
                className={`flex-1 px-2 py-3 text-xs font-medium transition-colors border-b-2 -mb-px ${
                  tab === t ? "text-white border-accent" : "text-muted hover:text-white border-transparent"
                }`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Content */}
      {tab === "charts" ? (
        <div className="h-[360px] overflow-y-auto">
          {chartsLoading ? (
            <div className="p-6 text-center text-muted text-sm animate-pulse">Loading…</div>
          ) : chartTracks.length === 0 ? (
            <div className="p-6 text-center text-muted text-sm">No chart data available</div>
          ) : (
            <ul>
              {chartTracks.map((track, i) => (
                <TrackRow
                  key={track.platformIds?.apple ?? track.isrc}
                  track={track}
                  rankNumber={i + 1}
                  added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                  onAdd={() => onAddTrack(track)}
                />
              ))}
            </ul>
          )}
        </div>
      ) : tab === "mfy" ? (
        isBrowsing ? (
          <div className="h-[360px] overflow-y-auto">
            <DrilldownView browsing={browsing!} queuedIsrcs={queuedIsrcs} onAddTrack={onAddTrack} />
          </div>
        ) : mfyLoading ? (
          <div className="h-[360px] flex items-center justify-center text-muted text-sm animate-pulse">Loading…</div>
        ) : playlists.length === 0 ? (
          <div className="h-[360px] flex items-center justify-center text-muted text-sm">No recommendations available</div>
        ) : (
          <>
            <ul className="overflow-y-auto h-[360px]">
              {playlists.map(playlist => (
                <PlaylistRow key={playlist.id} playlist={playlist} onSelect={() => handleSelectPlaylist(playlist)} />
              ))}
            </ul>
            <div className="px-4 py-2.5 border-t border-border/50 flex justify-end">
              <button onClick={refreshMfy} className="text-muted hover:text-white transition-colors" title="Shuffle">↻</button>
            </div>
          </>
        )
      ) : tab === "playlists" ? (
        isBrowsing ? (
          <div className="h-[360px] overflow-y-auto">
            <DrilldownView browsing={browsing!} queuedIsrcs={queuedIsrcs} onAddTrack={onAddTrack} />
          </div>
        ) : loadingLibrary ? (
          <div className="h-[360px] flex items-center justify-center text-muted text-sm animate-pulse">Loading…</div>
        ) : !libraryPlaylists || libraryPlaylists.length === 0 ? (
          <div className="h-[360px] flex items-center justify-center text-muted text-sm">No playlists found</div>
        ) : (
          <div className="h-[360px] flex flex-col">
            <div className="px-3 py-2 border-b border-border/50 flex-shrink-0">
              <div className="relative">
                <input
                  type="text"
                  value={playlistFilter}
                  onChange={e => setPlaylistFilter(e.target.value)}
                  placeholder="Filter playlists…"
                  className="w-full bg-surface text-white placeholder-muted rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-accent pr-6"
                />
                {playlistFilter && (
                  <button
                    onClick={() => setPlaylistFilter("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-white transition-colors text-sm leading-none"
                  >
                    ×
                  </button>
                )}
              </div>
            </div>
            <div ref={playlistScrollRef} className="flex-1 overflow-y-auto">
              <ul>
                {libraryPlaylists
                  .filter(pl => pl.name.toLowerCase().includes(playlistFilter.toLowerCase()))
                  .map(pl => (
                    <PlaylistRow key={pl.id} playlist={pl} onSelect={() => handleSelectPlaylist(pl)} />
                  ))}
              </ul>
            </div>
          </div>
        )
      ) : /* related tab */ (
        isBrowsing ? (
          <DrilldownView browsing={browsing!} queuedIsrcs={queuedIsrcs} onAddTrack={onAddTrack} />
        ) : relatedLoading || relatedError || relatedTracks.length === 0 ? (
          <>
            <ul>
              <TrackRowSkeleton />
              <TrackRowSkeleton />
              <TrackRowSkeleton />
            </ul>
            <div className="px-4 py-2.5 border-t border-border/50 flex items-center justify-between gap-3">
              {(relatedError || relatedTracks.length === 0) && !relatedLoading ? (
                <p className="text-xs text-muted">
                  {queue.length === 0 ? "Add tracks to the queue to get suggestions." : "None found."}
                </p>
              ) : <span />}
              <button onClick={refreshRelated} disabled={relatedLoading} className="text-muted hover:text-white transition-colors flex-shrink-0 disabled:opacity-30 disabled:cursor-not-allowed" title="Shuffle">↻</button>
            </div>
          </>
        ) : (
          <>
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
            {relatedSeed && relatedPlaylist && (
              <div className="px-4 py-2.5 border-t border-border/50 flex items-center justify-between gap-3">
                <p className="text-xs text-muted truncate">
                  <span className="text-white/70">{relatedSeed.name}</span>
                  <span className="text-muted/60"> appears on </span>
                  <span className="text-white/70">{relatedPlaylist.name}</span>
                  <span className="text-muted/60"> alongside these tracks</span>
                </p>
                <button
                  onClick={refreshRelated}
                  className="text-muted hover:text-white transition-colors flex-shrink-0"
                  title="Shuffle"
                >
                  ↻
                </button>
              </div>
            )}
          </>
        )
      )}
    </div>
  )
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function TrackRowSkeleton() {
  return (
    <li className="flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 animate-pulse">
      <div className="w-24 h-24 rounded flex-shrink-0 bg-surface" />
      <div className="flex-1 min-w-0 space-y-2">
        <div className="h-2.5 bg-surface rounded w-1/3" />
        <div className="h-4 bg-surface rounded w-3/4" />
        <div className="h-2.5 bg-surface rounded w-1/2" />
      </div>
    </li>
  )
}

function DrilldownView({ browsing, queuedIsrcs, onAddTrack }: {
  browsing: { playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult; tracks: Track[] | null }
  queuedIsrcs: Set<string>
  onAddTrack: (track: Track) => void
}) {
  return (
    <>
      <div className="flex items-center gap-4 px-4 py-4 border-b border-border bg-surface/40">
        <div className="w-32 h-32 rounded-lg flex-shrink-0 overflow-hidden bg-surface shadow-md">
          {browsing.playlist.artworkUrl
            ? <img src={artworkUrl(browsing.playlist.artworkUrl, 128)} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-muted text-xl"><ListMusic size={24} /></div>}
        </div>
        <div className="min-w-0">
          <p className="text-white text-base font-bold truncate">{browsing.playlist.name}</p>
          {browsing.playlist.subtitle && <p className="text-muted text-sm truncate mt-0.5">{browsing.playlist.subtitle}</p>}
        </div>
      </div>
      {browsing.tracks === null ? (
        <div className="p-6 text-center text-muted text-sm animate-pulse">Loading tracks…</div>
      ) : browsing.tracks.length === 0 ? (
        <div className="p-6 text-center text-muted text-sm">No tracks found</div>
      ) : (
        <ul>
          {browsing.tracks.map((track, i) => (
            <TrackRow
              key={track.platformIds?.apple ?? track.isrc}
              track={track}
              trackNumber={browsing.playlist.kind === "album" ? i + 1 : undefined}
              added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
              onAdd={() => onAddTrack(track)}
            />
          ))}
        </ul>
      )}
    </>
  )
}

function PlaylistRow({ playlist, onSelect }: {
  playlist: PlaylistResult | LibraryPlaylistResult | AlbumResult
  onSelect: () => void
}) {
  const trackCount = 'trackCount' in playlist && playlist.trackCount != null
    ? `${playlist.trackCount} track${playlist.trackCount !== 1 ? "s" : ""}`
    : null
  const subtitle = playlist.subtitle && trackCount ? `${playlist.subtitle} — ${trackCount}`
    : playlist.subtitle || trackCount || null

  return (
    <li className="border-b border-border/50 last:border-0">
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={e => e.key === "Enter" && onSelect()}
        className="flex items-center gap-3 px-4 py-3 hover:bg-surface/50 transition-colors cursor-pointer"
      >
        <div className="w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
          {playlist.artworkUrl
            ? <img src={artworkUrl(playlist.artworkUrl, 96)} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-muted text-sm"><ListMusic size={14} /></div>}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-white text-base truncate">{playlist.name}</p>
          {subtitle && <p className="text-muted text-sm truncate">{subtitle}</p>}
        </div>
        <ChevronRight size={14} className="text-muted flex-shrink-0" />
      </div>
    </li>
  )
}
