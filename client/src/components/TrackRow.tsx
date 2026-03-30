import { Trash2 } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import { formatDuration } from "../utils"
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
}

export function TrackRow({ track, trackNumber, rankNumber, hideArtist, added, onAdd, onRemove, unavailable, onAlbumClick }: Props) {
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
            ? <img src={artworkUrl(track.artworkUrl, 96)} alt="" className="w-full h-full object-cover" />
            : <div className="w-full h-full flex items-center justify-center text-muted text-sm">♪</div>
          }
          {unavailable && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-amber-400 text-xs font-bold">!</div>
          )}
        </div>
      )}

      <div className="flex-1 min-w-0">
        {unavailable
          ? <p className="text-muted text-xs truncate">No longer available</p>
          : !hideArtist && <p className="text-muted/70 text-xs truncate">{track.artistName}</p>}
        <p className={`text-base font-semibold truncate ${unavailable ? "text-muted/50 line-through" : "text-white"}`}>{track.name}</p>
        {!unavailable && trackNumber == null && (
          onAlbumClick
            ? <button onClick={onAlbumClick} className="text-muted/50 text-xs truncate hover:text-muted/80 transition-colors text-left w-full">{track.albumName}</button>
            : <p className="text-muted/50 text-xs truncate">{track.albumName}</p>
        )}
      </div>

      <span className="text-sm text-muted tabular-nums flex-shrink-0">{formatDuration(track.durationMs)}</span>

      <div className="flex items-center gap-1 flex-shrink-0">
        {onRemove && (
          <button
            onClick={onRemove}
            className="opacity-0 group-hover:opacity-100 w-7 h-7 rounded-full flex items-center justify-center text-muted hover:text-red-400 transition-all"
            title="Remove from pool"
          >
            <Trash2 size={14} />
          </button>
        )}
        <button
          onClick={onAdd}
          disabled={added || unavailable}
          className={`w-7 h-7 rounded-full flex items-center justify-center text-sm transition-all ${
            added ? "bg-green-500/20 text-green-400" : unavailable ? "bg-surface text-muted cursor-not-allowed" : "bg-surface text-muted hover:bg-accent hover:text-white"
          }`}
          title={unavailable ? "No longer available" : "Add to queue"}
        >
          {added ? "✓" : "+"}
        </button>
      </div>
    </div>
  )
}
