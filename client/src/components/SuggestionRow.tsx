import { ArrowUp, Trash2 } from "lucide-react"
import { artworkUrl } from "../services/musickit"
import type { SuggestedTrack } from "../types"

interface Props {
  suggestion: SuggestedTrack
  currentUserId: string
  isPrivileged: boolean
  onVote: () => void
  onEnqueue?: () => void
  onRemove?: () => void
}

export function SuggestionRow({ suggestion, currentUserId, isPrivileged, onVote, onEnqueue, onRemove }: Props) {
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
        <p className="text-muted/50 text-xs truncate mt-0.5">
          requested by <span className="text-muted/80">{suggestion.suggestedByName ?? suggestion.suggestedBy}</span>
        </p>
      </div>

      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={onVote}
          disabled={hasVoted}
          title={hasVoted ? "Already voted" : "Upvote"}
          className={`h-9 px-2.5 rounded-full flex items-center gap-1 text-sm font-medium transition-all ${
            hasVoted
              ? "bg-accent/20 text-accent cursor-default"
              : "bg-surface text-muted hover:bg-accent/20 hover:text-accent"
          }`}
        >
          <ArrowUp size={14} />
          <span>{suggestion.votes}</span>
        </button>

        {onEnqueue && (
          <button
            onClick={onEnqueue}
            title="Add to queue"
            className="w-9 h-9 rounded-full flex items-center justify-center text-base bg-surface text-muted hover:bg-accent hover:text-white transition-all"
          >
            +
          </button>
        )}

        {onRemove && (
          <button
            onClick={onRemove}
            title="Remove suggestion"
            className="w-9 h-9 rounded-full flex items-center justify-center text-muted hover:text-red-400 transition-colors"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  )
}
