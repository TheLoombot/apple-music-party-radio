import { ArrowUp, Plus, Trash2 } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import type { SuggestedTrack } from "../types"

interface Props {
  suggestion: SuggestedTrack
  currentUserId: string
  isPrivileged: boolean
  onVote: () => void
  onRetract: () => void
  onEnqueue?: () => void
  onRemove?: () => void
}

export function SuggestionRow({ suggestion, currentUserId, isPrivileged, onVote, onRetract, onEnqueue, onRemove }: Props) {
  const hasVoted = suggestion.votedBy.includes(currentUserId)

  return (
    <li className="flex items-center gap-3 px-4 py-3 border-b border-border/50 last:border-0 hover:bg-surface/50">
      <div className="w-12 h-12 rounded flex-shrink-0 overflow-hidden bg-surface">
        {suggestion.artworkUrl
          ? <img src={artworkUrl(suggestion.artworkUrl, 96)} alt="" loading="lazy" className="w-full h-full object-cover" />
          : <div className="w-full h-full flex items-center justify-center text-muted text-sm">♪</div>
        }
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-muted/70 text-xs truncate">{suggestion.artistName}</p>
        <p className="text-white text-sm font-semibold truncate">{suggestion.name}</p>
        <p className="text-muted/50 text-xs truncate">{suggestion.albumName}</p>
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        {/* Vote toggle — tapping when you've already voted retracts it. The
            depressed state stands in for the old red "voted" pill so it reads
            like the rest of the app's hardware-button UI. */}
        <button
          onClick={hasVoted ? onRetract : onVote}
          aria-label={hasVoted ? "Retract your vote" : "Upvote"}
          title={hasVoted ? "Retract your vote" : "Upvote"}
          className={`btn-3d h-11 px-3 rounded-lg flex items-center gap-1.5 text-sm font-semibold text-white ${hasVoted ? "btn-3d-pressed" : ""}`}
        >
          <ArrowUp size={16} strokeWidth={3} />
          <span className="tabular-nums">{suggestion.votes}</span>
        </button>

        {onEnqueue && (
          <button
            onClick={onEnqueue}
            aria-label="Add to queue"
            title="Add to queue"
            className="btn-3d w-12 h-11 rounded-lg flex items-center justify-center text-white"
          >
            <Plus size={20} strokeWidth={3} />
          </button>
        )}

        {onRemove && (
          <button
            onClick={onRemove}
            aria-label="Reject request"
            title="Reject request"
            className="btn-3d w-12 h-11 rounded-lg flex items-center justify-center text-muted hover:text-red-400"
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </li>
  )
}
