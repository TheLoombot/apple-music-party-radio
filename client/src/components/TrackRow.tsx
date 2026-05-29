import { Trash2, ArrowUp, Plus, Check } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
import { Tooltip } from "./Tooltip"
import type { Track } from "../types"

interface Props {
  track: Track
  trackNumber?: number
  rankNumber?: number
  hideArtist?: boolean
  added: boolean
  onAdd: () => void
  onRemove?: () => void
  unavailable?: boolean
  onAlbumClick?: () => void
  requestMode?: boolean
}

export function TrackRow({ track, trackNumber, rankNumber, hideArtist, added, onAdd, onRemove, unavailable, onAlbumClick, requestMode }: Props) {
  return (
    <div className={`flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50 group ${unavailable ? "opacity-50" : ""}`}>
      {rankNumber != null && (
        <span className="text-base font-bold text-muted/60 w-7 text-right flex-shrink-0 tabular-nums">{rankNumber}</span>
      )}
      {trackNumber != null ? (
        <span className="text-xs text-muted w-5 text-right flex-shrink-0 tabular-nums">{trackNumber}</span>
      ) : (
        <div className="relative w-24 h-24 rounded flex-shrink-0 overflow-hidden bg-surface">
          {track.artworkUrl
            ? <img src={artworkUrl(track.artworkUrl, 96)} alt="" loading="lazy" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-muted text-sm">♪</div>
          }
          {unavailable && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-amber-400 text-xs font-bold">!</div>
          )}
        </div>
      )}

      <div className="flex-1 min-w-0">
        {unavailable
          ? <p className="text-amber-500/70 text-xs truncate">Not available in Apple Music</p>
          : !hideArtist && <p className="text-muted/70 text-xs truncate">{track.artistName}</p>}
        <p className={`text-base font-semibold ${unavailable ? "text-muted/50 line-through" : "text-white"}`}>{track.name}</p>
        {!unavailable && trackNumber == null && (
          onAlbumClick
            ? <button onClick={onAlbumClick} className="text-muted/50 text-xs truncate hover:text-red-400 transition-colors text-left w-full">{track.albumName}</button>
            : <p className="text-muted/50 text-xs truncate">{track.albumName}</p>
        )}
      </div>

      <span className="text-sm text-muted tabular-nums flex-shrink-0">{formatDuration(track.durationMs)}</span>

      <div className="flex items-center gap-2 flex-shrink-0">
        {onRemove && (
          <Tooltip label="Remove from pool" align="end">
            <button
              onClick={onRemove}
              aria-label="Remove from pool"
              className="btn-3d w-12 h-12 rounded-lg flex items-center justify-center text-muted hover:text-red-400"
            >
              <Trash2 size={18} />
            </button>
          </Tooltip>
        )}
        {(() => {
          const addLabel = unavailable
            ? "Not available in Apple Music"
            : added
              ? (requestMode ? "Already requested" : "Remove from queue")
              : (requestMode ? "Request track" : "Add to queue")
          return (
            <Tooltip label={addLabel} align="end">
              <button
                onClick={onAdd}
                disabled={unavailable}
                aria-label={addLabel}
                className={`btn-3d w-14 h-12 rounded-lg flex items-center justify-center ${
                  added
                    ? "btn-3d-pressed text-green-400 hover:text-red-400"
                    : unavailable
                      ? "text-muted opacity-50 cursor-not-allowed"
                      : "btn-3d-accent"
                }`}
              >
                {added
                  ? <Check size={24} strokeWidth={3} />
                  : requestMode
                    ? <ArrowUp size={24} strokeWidth={3} />
                    : <Plus size={24} strokeWidth={3} />}
              </button>
            </Tooltip>
          )
        })()}
      </div>
    </div>
  )
}
