import { useCallback, useEffect, useRef, useState, useMemo } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X, Trash2, ChevronLeft, Disc3 } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { formatDuration, relativeTime } from "../utils"
import { TrackRow } from "./TrackRow"
import { LoadingDots } from "./LoadingDots"
import { ArtworkModal } from "./ArtworkModal"
import type { PoolTrack, AppUser, Track, AlbumResult } from "../types"
import type { MusicCatalog } from "../services/catalog"

interface Props {
  pool: PoolTrack[]
  currentUser: AppUser
  canManagePool: boolean   // owner or DJ: can remove individual tracks
  canClearPool: boolean    // owner only: can clear all
  queuedIsrcs: Set<string>
  onAddTrack: (track: Track) => void
  onRemoveFromPool: (isrc: string) => void
  onClearPool: () => void
  onClose: () => void
  catalog?: MusicCatalog
}


export function PoolModal({ pool, currentUser, canManagePool, canClearPool, queuedIsrcs, onAddTrack, onRemoveFromPool, onClearPool, onClose, catalog }: Props) {
  const sorted = useMemo(() => pool.slice().reverse(), [pool])

  const [filterQuery, setFilterQuery] = useState("")
  const filtered = useMemo(() => {
    if (!filterQuery.trim()) return sorted
    const q = filterQuery.toLowerCase()
    return sorted.filter(t => t.name.toLowerCase().includes(q) || t.artistName.toLowerCase().includes(q))
  }, [sorted, filterQuery])

  // Album drill-down
  const [album, setAlbum] = useState<AlbumResult | null>(null)
  const [albumTracks, setAlbumTracks] = useState<Track[] | null>(null)
  const [artworkOpen, setArtworkOpen] = useState(false)
  const closeArtwork = useCallback(() => setArtworkOpen(false), [])
  const navOpRef = useRef(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const savedScrollRef = useRef(0)
  const restoreScrollRef = useRef<number | null>(null)

  // Restore pool scroll when navigating back
  useEffect(() => {
    if (restoreScrollRef.current !== null && scrollRef.current) {
      scrollRef.current.scrollTop = restoreScrollRef.current
      restoreScrollRef.current = null
    }
  })

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && !artworkOpen) onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose, artworkOpen])

  async function handleAlbumClick(songId: string) {
    if (!catalog) return
    const op = ++navOpRef.current
    const placeholder: AlbumResult = { kind: "album", id: "_loading", name: "", subtitle: "", artworkUrl: "" }
    savedScrollRef.current = scrollRef.current?.scrollTop ?? 0
    setAlbum(placeholder)
    setAlbumTracks(null)

    const result = await catalog.getAlbumForTrack(songId)
    if (navOpRef.current !== op || !result) { setAlbum(null); return }
    setAlbum(result)

    const tracks = await catalog.getAlbumTracks(result.id)
    if (navOpRef.current === op) setAlbumTracks(tracks)
  }

  function handleBack() {
    ++navOpRef.current
    restoreScrollRef.current = savedScrollRef.current
    setAlbum(null)
    setAlbumTracks(null)
    setArtworkOpen(false)
  }

  const inAlbum = album !== null

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-black/80"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={onClose}
    >
      <motion.div
        className="w-full sm:max-w-lg bg-panel rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col h-[80vh]"
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        {inAlbum ? (
          <div className="flex items-center gap-3 px-4 py-4 border-b border-border bg-surface/40 flex-shrink-0">
            <button onClick={handleBack} className="text-muted hover:text-white transition-colors flex-shrink-0 p-1">
              <ChevronLeft size={18} />
            </button>
            <div className="w-12 h-12 rounded flex-shrink-0 overflow-hidden bg-surface">
              {album.artworkUrl
                ? <button onClick={() => setArtworkOpen(true)} className="block w-full h-full cursor-zoom-in">
                    <img src={artworkUrl(album.artworkUrl, 48)} alt="" className="w-full h-full object-cover" />
                  </button>
                : <div className="w-full h-full flex items-center justify-center text-muted"><Disc3 size={16} /></div>}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-bold truncate">{album.name || <LoadingDots />}</p>
              {album.subtitle && <p className="text-muted text-xs truncate">{album.subtitle}</p>}
            </div>
            <button onClick={onClose} className="text-muted hover:text-white transition-colors flex-shrink-0 p-1">
              <X size={18} />
            </button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
              <div>
                <h2 className="text-white font-semibold text-base">Station Pool</h2>
                {pool.length > 0 && (
                  <p className="text-muted text-xs mt-0.5">{pool.length} track{pool.length !== 1 ? "s" : ""} — robot DJ picks from here</p>
                )}
              </div>
              <button onClick={onClose} className="text-muted hover:text-white transition-colors p-1">
                <X size={18} />
              </button>
            </div>
            {pool.length > 0 && (
              <div className="px-4 py-2 border-b border-border flex-shrink-0">
                <div className="relative">
                  <input
                    type="text"
                    value={filterQuery}
                    onChange={e => setFilterQuery(e.target.value)}
                    placeholder="Filter pool…"
                    className="w-full bg-surface text-white placeholder-muted rounded-lg px-3 py-1.5 text-xs outline-none focus:ring-1 focus:ring-accent pr-6"
                  />
                  {filterQuery && (
                    <button
                      onClick={() => setFilterQuery("")}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-white transition-colors text-sm leading-none"
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>
            )}
          </>
        )}

        {/* Content */}
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto">
          {inAlbum ? (
            albumTracks === null ? (
              <div className="p-6 text-center text-muted text-sm"><LoadingDots /></div>
            ) : albumTracks.length === 0 ? (
              <div className="p-6 text-center text-muted text-sm">No tracks found</div>
            ) : (
              <ul>
                {albumTracks.map((track, i) => (
                  <TrackRow
                    key={track.platformIds?.apple ?? track.isrc ?? track.name}
                    track={track}
                    trackNumber={i + 1}
                    hideArtist={track.artistName === album!.subtitle}
                    added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")}
                    onAdd={() => onAddTrack(track)}
                  />
                ))}
              </ul>
            )
          ) : pool.length === 0 ? (
            <div className="p-8 text-center text-muted text-sm">
              <p>Nothing in the pool yet.</p>
              <p className="text-xs mt-1 opacity-60">Tracks land here after they finish playing.</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-muted text-sm">No matches</div>
          ) : (
            <>
              <ul>
                <AnimatePresence initial={false}>
                  {filtered.map(track => {
                    const added = queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.platformIds?.apple ?? "")
                    const unavailable = !track.platformIds?.apple
                    return (
                      <motion.li
                        key={track.isrc || track.platformIds?.apple || track.name}
                        layout
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
                        transition={{ duration: 0.2 }}
                        className={`flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 group ${unavailable ? "opacity-50" : ""}`}
                      >
                        <div className="w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
                          {track.artworkUrl
                            ? <img src={artworkUrl(track.artworkUrl, 96)} alt="" className="w-full h-full object-cover" />
                            : <div className="w-full h-full flex items-center justify-center text-muted text-sm">♪</div>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-muted/70 text-xs">{track.artistName}</p>
                          <p className="text-white text-base font-semibold">{track.name}</p>
                          {track.albumName && (
                            catalog && track.platformIds?.apple
                              ? <button onClick={() => handleAlbumClick(track.platformIds.apple!)} className="text-muted/50 text-xs hover:text-red-400 transition-colors text-left">{track.albumName}</button>
                              : <p className="text-muted/50 text-xs">{track.albumName}</p>
                          )}
                          <p className="text-muted text-xs mt-2">
                            played {track.playCount}× · last {relativeTime(track.lastPlayedAt)}
                            {track.addedByUsers.length > 0 && (
                              <>
                                <span className="mx-1">·</span>
                                queued by{" "}
                                {track.addedByUsers.map((u, i) => (
                                  <span key={u}>
                                    <span className="text-white/60">{u === currentUser.uid ? "you" : u}</span>
                                    {i < track.addedByUsers.length - 1 ? ", " : ""}
                                  </span>
                                ))}
                              </>
                            )}
                          </p>
                        </div>
                        <span className="text-xs text-muted tabular-nums flex-shrink-0">{formatDuration(track.durationMs)}</span>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {canManagePool && (
                            <button
                              onClick={() => onRemoveFromPool(track.isrc)}
                              className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-full flex items-center justify-center text-muted hover:text-red-400 transition-all"
                              title="Remove from pool"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                          <button
                            onClick={() => onAddTrack(track)}
                            disabled={unavailable}
                            className={`w-7 h-7 rounded-full flex items-center justify-center text-sm transition-all ${
                              added ? "bg-green-500/20 text-green-400 hover:bg-red-500/20 hover:text-red-400" : unavailable ? "bg-surface text-muted cursor-not-allowed" : "bg-surface text-muted hover:bg-accent hover:text-white"
                            }`}
                            title={unavailable ? "No longer available" : added ? "Remove from queue" : "Add to queue"}
                          >
                            {added ? "✓" : "+"}
                          </button>
                        </div>
                      </motion.li>
                    )
                  })}
                </AnimatePresence>
              </ul>

              {canClearPool && !filterQuery && (
                <div className="px-4 py-4 flex justify-center border-t border-border/50">
                  <button
                    onClick={onClearPool}
                    className="flex items-center gap-1.5 text-muted hover:text-red-400 transition-colors text-sm"
                  >
                    <Trash2 size={13} />
                    <span>Clear All</span>
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </motion.div>
      <AnimatePresence>
        {artworkOpen && album?.artworkUrl && (
          <ArtworkModal
            src={artworkUrl(album.artworkUrl, 1500)}
            alt={album.name}
            onClose={closeArtwork}
            catalog={catalog}
            albumId={album.id !== "_loading" ? album.id : undefined}
            albumName={album.name}
            releaseYear={album.releaseYear}
          />
        )}
      </AnimatePresence>
    </motion.div>
  )
}
