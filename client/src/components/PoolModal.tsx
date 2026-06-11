import { useCallback, useEffect, useRef, useState, useMemo } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X, Trash2, ChevronLeft, Disc3, Plus, Check, Music, Download, Upload } from "lucide-react"
import { Tooltip } from "./Tooltip"
import { artworkUrl } from "../services/musickit"
import { formatDuration, relativeTime } from "../utils"
import { TrackRow } from "./TrackRow"
import { LoadingDots } from "./LoadingDots"
import { ArtworkModal } from "./ArtworkModal"
import { poolToCsv, parsePoolCsv } from "../services/poolCsv"
import { sameTrack } from "../../../shared/track"
import type { PoolTrack, AppUser, Track, AlbumResult } from "../types"
import type { MusicCatalog } from "../services/catalog"

interface Props {
  pool: PoolTrack[]
  currentUser: AppUser
  canManagePool: boolean   // owner or DJ: can remove individual tracks
  canClearPool: boolean    // owner only: can clear all
  queuedIsrcs: Set<string>
  nowPlayingIds: Set<string>
  onAddTrack: (track: Track) => void
  onRemoveFromPool: (isrc: string) => void
  onClearPool: () => void
  onImportPool?: (tracks: object[]) => void
  onClose: () => void
  catalog?: MusicCatalog
  stationId?: string  // for the export filename
}

/** A CSV row resolved against the catalog, ready to send to the server. */
type ImportEntry = Track & { playCount?: number; lastPlayedAt?: number }

type ImportState =
  | { phase: "resolving" }
  | { phase: "confirm"; tracks: ImportEntry[]; unresolved: number; dupes: number; overflow: number }
  | { phase: "error"; message: string }


export function PoolModal({ pool, currentUser, canManagePool, canClearPool, queuedIsrcs, nowPlayingIds, onAddTrack, onRemoveFromPool, onClearPool, onImportPool, onClose, catalog, stationId }: Props) {
  const sorted = useMemo(() => pool.slice().reverse(), [pool])

  // ─── CSV export / import ───────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importState, setImportState] = useState<ImportState | null>(null)

  const handleExport = () => {
    // Empty pool → headers-only file, which doubles as the import template.
    const blob = new Blob([poolToCsv(pool)], { type: "text/csv;charset=utf-8" })
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = pool.length === 0
      ? "hat.fm-pool-template.csv"
      : `hat.fm-${stationId || "station"}-pool-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function handleImportFile(file: File) {
    if (!catalog) return
    setImportState({ phase: "resolving" })
    try {
      const rows = parsePoolCsv(await file.text())
      const usable = rows.filter(r => r.isrc || r.appleId)
      let unresolved = rows.length - usable.length

      // Resolve by Apple ID first, then heal the remainder via ISRC. Every
      // entry comes back canonical for the importer's storefront: fresh
      // artwork, real duration, current playability.
      const ids = [...new Set(usable.map(r => r.appleId).filter(Boolean))]
      const byIdTracks = ids.length ? await catalog.getSongsByIds(ids) : []
      const byId = new Map(byIdTracks.map(t => [t.appleId ?? "", t]))
      const needIsrc = usable.filter(r => !(r.appleId && byId.has(r.appleId)) && r.isrc)
      const isrcs = [...new Set(needIsrc.map(r => r.isrc))]
      const byIsrcTracks = isrcs.length ? await catalog.getSongsByIsrcs(isrcs) : []
      const byIsrc = new Map(
        [...byIdTracks, ...byIsrcTracks].filter(t => t.isrc).map(t => [t.isrc, t])
      )

      const entries: ImportEntry[] = []
      const seen = new Set<string>()
      for (const r of usable) {
        const t = (r.appleId ? byId.get(r.appleId) : undefined) ?? (r.isrc ? byIsrc.get(r.isrc) : undefined)
        if (!t?.appleId) { unresolved++; continue }
        const k = t.isrc || t.appleId
        if (seen.has(k)) continue // duplicate row within the file
        seen.add(k)
        entries.push({ ...t, playCount: r.playCount, lastPlayedAt: r.lastPlayedAt })
      }

      const fresh = entries.filter(e => !pool.some(p => sameTrack(p, e)))
      const dupes = entries.length - fresh.length
      const capacity = Math.max(0, 100 - pool.length)
      const overflow = Math.max(0, fresh.length - capacity)
      const tracks = fresh.slice(0, capacity)

      if (tracks.length === 0) {
        setImportState({
          phase: "error",
          message: unresolved + dupes === 0
            ? "No importable rows found in that file."
            : `Nothing to add — ${dupes} already in the pool, ${unresolved} unresolvable.`,
        })
      } else {
        setImportState({ phase: "confirm", tracks, unresolved, dupes, overflow })
      }
    } catch (e: any) {
      setImportState({ phase: "error", message: e?.message ?? "Couldn't read that file." })
    }
  }

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
            <button onClick={handleBack} className="text-muted hover:text-white transition-colors w-10 h-10 flex items-center justify-center flex-shrink-0">
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
            <button onClick={onClose} className="text-muted hover:text-white transition-colors w-10 h-10 flex items-center justify-center flex-shrink-0">
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
              {/* Tooltips here use position=bottom — the modal card is
               *  overflow-hidden, so a top-anchored tooltip in the header
               *  clips at the modal edge. */}
              <div className="flex items-center gap-1">
                <Tooltip label={pool.length > 0 ? "Export pool as CSV" : "Download CSV template"} align="end" position="bottom">
                  <button
                    onClick={handleExport}
                    aria-label={pool.length > 0 ? "Export pool as CSV" : "Download CSV template"}
                    className="text-muted hover:text-white transition-colors w-9 h-9 flex items-center justify-center"
                  >
                    <Download size={16} />
                  </button>
                </Tooltip>
                {canManagePool && catalog && onImportPool && (
                  <Tooltip label="Import pool CSV" align="end" position="bottom">
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      aria-label="Import pool CSV"
                      className="text-muted hover:text-white transition-colors w-9 h-9 flex items-center justify-center"
                    >
                      <Upload size={16} />
                    </button>
                  </Tooltip>
                )}
                <button onClick={onClose} className="text-muted hover:text-white transition-colors p-1 ml-1">
                  <X size={18} />
                </button>
              </div>
              {/* Hidden file input for CSV import; value reset so the same
               *  file can be re-selected after a cancel. */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0]
                  e.target.value = ""
                  if (f) void handleImportFile(f)
                }}
              />
            </div>
            {importState && (
              <div className="px-4 py-3 border-b border-border bg-surface/40 flex-shrink-0 text-sm">
                {importState.phase === "resolving" ? (
                  <span className="text-muted">Resolving tracks against Apple Music… <LoadingDots /></span>
                ) : importState.phase === "error" ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-red-400 text-xs">{importState.message}</span>
                    <button onClick={() => setImportState(null)} className="text-muted hover:text-white text-xs flex-shrink-0">Dismiss</button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-white">Add {importState.tracks.length} track{importState.tracks.length !== 1 ? "s" : ""} to the pool?</p>
                      {(importState.unresolved > 0 || importState.dupes > 0 || importState.overflow > 0) && (
                        <p className="text-muted text-xs mt-0.5">
                          {[
                            importState.unresolved > 0 && `${importState.unresolved} unresolvable, skipped`,
                            importState.dupes > 0 && `${importState.dupes} already in pool`,
                            importState.overflow > 0 && `${importState.overflow} over the 100-track cap`,
                          ].filter(Boolean).join(" · ")}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button onClick={() => setImportState(null)} className="text-muted hover:text-white text-xs py-1.5 px-2">Cancel</button>
                      <button
                        onClick={() => { onImportPool?.(importState.tracks); setImportState(null) }}
                        className="btn-3d rounded-lg text-white text-xs font-semibold py-1.5 px-3"
                      >
                        Import
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
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
                      className="absolute right-0 top-1/2 -translate-y-1/2 w-8 h-8 flex items-center justify-center text-muted hover:text-white transition-colors"
                    >
                      <X size={14} />
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
                    key={track.appleId ?? track.isrc ?? track.name}
                    track={track}
                    trackNumber={i + 1}
                    hideArtist={track.artistName === album!.subtitle}
                    added={queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.appleId ?? "")}
                    isNowPlaying={nowPlayingIds.has(track.isrc) || nowPlayingIds.has(track.appleId ?? "")}
                    onAdd={() => onAddTrack(track)}
                  />
                ))}
              </ul>
            )
          ) : pool.length === 0 ? (
            <div className="p-8 text-center text-muted text-sm">
              <p>Nothing in the pool yet.</p>
              <p className="text-xs mt-1 opacity-60">
                Tracks land here after they finish playing.
                {canManagePool && catalog && onImportPool && (
                  <> Or import a pool CSV with the <Upload size={11} className="inline -mt-0.5" /> button above.</>
                )}
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-muted text-sm">No matches</div>
          ) : (
            <>
              <ul>
                <AnimatePresence initial={false}>
                  {filtered.map(track => {
                    const added = queuedIsrcs.has(track.isrc) || queuedIsrcs.has(track.appleId ?? "")
                    const unavailable = !track.appleId
                    const isNowPlaying = nowPlayingIds.has(track.isrc) || nowPlayingIds.has(track.appleId ?? "")
                    return (
                      <motion.li
                        key={track.isrc || track.appleId || track.name}
                        layout
                        initial={{ opacity: 0, y: -6 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, x: 40, transition: { duration: 0.18 } }}
                        transition={{ duration: 0.2 }}
                        className={`flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 group ${unavailable ? "opacity-50" : ""}`}
                      >
                        <div className="w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
                          {track.artworkUrl
                            ? <img src={artworkUrl(track.artworkUrl, 96)} alt="" loading="lazy" className="w-full h-full object-cover" />
                            : <div className="w-full h-full flex items-center justify-center text-muted text-sm">♪</div>}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-muted/70 text-xs">{track.artistName}</p>
                          <p className="text-white text-base font-semibold">{track.name}</p>
                          {track.albumName && (
                            catalog && track.appleId
                              ? <button onClick={() => handleAlbumClick(track.appleId!)} className="text-muted/50 text-xs hover:text-red-400 transition-colors text-left">{track.albumName}</button>
                              : <p className="text-muted/50 text-xs">{track.albumName}</p>
                          )}
                          <p className="text-muted text-xs mt-2">
                            played {track.playCount}× · last {relativeTime(track.lastPlayedAt)}
                            {track.addedByUsers.length > 0 && (
                              <>
                                <span className="mx-1">·</span>
                                queued by{" "}
                                {track.addedByUsers.map((u, i) => {
                                  const name = u === currentUser.uid
                                    ? currentUser.displayName
                                    : track.addedByNames?.[u] ?? u
                                  return (
                                    <span key={u}>
                                      <span className="text-white/60">{name}</span>
                                      {i < track.addedByUsers.length - 1 ? ", " : ""}
                                    </span>
                                  )
                                })}
                              </>
                            )}
                          </p>
                        </div>
                        <span className="text-xs text-muted tabular-nums flex-shrink-0">{formatDuration(track.durationMs)}</span>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {isNowPlaying ? (
                            <Tooltip label="Now playing on this station" align="end">
                              <div
                                aria-label="Now playing"
                                className="btn-3d btn-3d-pressed w-14 h-12 rounded-lg flex items-center justify-center text-amber-400 cursor-default"
                              >
                                <Music size={20} />
                              </div>
                            </Tooltip>
                          ) : (
                            <>
                              {canManagePool && (
                                <Tooltip label="Remove from pool" align="end">
                                  <button
                                    onClick={() => onRemoveFromPool(track.isrc)}
                                    aria-label="Remove from pool"
                                    className="btn-3d w-12 h-12 rounded-lg flex items-center justify-center text-muted hover:text-red-400"
                                  >
                                    <Trash2 size={18} />
                                  </button>
                                </Tooltip>
                              )}
                              {(() => {
                                const addLabel = unavailable
                                  ? "No longer available"
                                  : added ? "Remove from queue" : "Add to queue"
                                return (
                                  <Tooltip label={addLabel} align="end">
                                    <button
                                      onClick={() => onAddTrack(track)}
                                      disabled={unavailable}
                                      aria-label={addLabel}
                                      className={`btn-3d w-14 h-12 rounded-lg flex items-center justify-center ${
                                        added
                                          ? "btn-3d-pressed text-white/35 hover:text-red-400"
                                          : unavailable
                                            ? "text-muted opacity-50 cursor-not-allowed"
                                            : "text-white"
                                      }`}
                                    >
                                      {added
                                        ? <Check size={24} strokeWidth={3} style={{ filter: "none" }} />
                                        : <Plus size={24} strokeWidth={3} />}
                                    </button>
                                  </Tooltip>
                                )
                              })()}
                            </>
                          )}
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
            src={artworkUrl(album.artworkUrl, 750)}
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
