import { useEffect, Component } from "react"
import type { ReactNode, ErrorInfo } from "react"
import { motion } from "framer-motion"
import { X } from "lucide-react"
import { Discovery } from "./Discovery"
import type { MusicCatalog } from "../services/catalog"
import { log } from "../services/log"
import type { Track, QueueItem, SuggestedTrack } from "../types"

class DiscoveryErrorBoundary extends Component<{ children: ReactNode; onClose: () => void }, { error: Error | null }> {
  state = { error: null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    log.app.error("DiscoveryModal crash:", error.message, error.stack, "Component stack:", info.componentStack)
  }
  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 p-6 text-center">
          <p className="text-red-400 text-sm font-medium">Something went wrong loading this panel.</p>
          <p className="text-muted text-xs font-mono">{(this.state.error as Error).message}</p>
          <button onClick={this.props.onClose} className="text-muted text-xs underline">Close</button>
        </div>
      )
    }
    return this.props.children
  }
}

interface Props {
  onClose: () => void
  catalog: MusicCatalog
  queuedIsrcs: Set<string>
  userQueuedIds: Set<string>
  nowPlayingIds: Set<string>
  suggestedIsrcs: Set<string>
  queue: QueueItem[]
  onAddTrack: (track: Track) => void
  suggestions: SuggestedTrack[]
  isPrivileged: boolean
  currentUserId: string
  onVoteSuggestion: (key: string) => void
  onRetractSuggestion: (key: string) => void
  onEnqueueSuggestion?: (key: string) => void
  onRemoveSuggestion?: (key: string) => void
  previewingId: string | null
  onTogglePreview: (track: Track) => void
  mode?: "modal" | "panel"
}

export function DiscoveryModal({ onClose, catalog, queuedIsrcs, userQueuedIds, nowPlayingIds, suggestedIsrcs, queue, onAddTrack, suggestions, isPrivileged, currentUserId, onVoteSuggestion, onRetractSuggestion, onEnqueueSuggestion, onRemoveSuggestion, previewingId, onTogglePreview, mode = "modal" }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  const header = (
    <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
      <span className="text-xs text-muted font-medium uppercase tracking-wider">
        {isPrivileged ? "Add or Request" : "Request a Track"}
      </span>
      <button
        onClick={onClose}
        aria-label="Close"
        className="text-muted hover:text-white transition-colors w-10 h-10 flex items-center justify-center flex-shrink-0"
      >
        <X size={18} />
      </button>
    </div>
  )

  const content = (
    <DiscoveryErrorBoundary onClose={onClose}>
      <Discovery
        catalog={catalog}
        queuedIsrcs={queuedIsrcs}
        userQueuedIds={userQueuedIds}
        nowPlayingIds={nowPlayingIds}
        suggestedIsrcs={suggestedIsrcs}
        queue={queue}
        onAddTrack={onAddTrack}
        embedded
        suggestions={suggestions}
        isPrivileged={isPrivileged}
        currentUserId={currentUserId}
        onVoteSuggestion={onVoteSuggestion}
        onRetractSuggestion={onRetractSuggestion}
        onEnqueueSuggestion={onEnqueueSuggestion}
        onRemoveSuggestion={onRemoveSuggestion}
        previewingId={previewingId}
        onTogglePreview={onTogglePreview}
      />
    </DiscoveryErrorBoundary>
  )

  if (mode === "panel") {
    return (
      <motion.div
        /* In-flow side panel — lives inside its 400px slot. Sticky so it
         *  stays pinned near the top as the page scrolls. */
        className="w-full sticky top-0 bg-panel rounded-xl overflow-hidden flex flex-col h-[calc(100vh-2rem)]"
        initial={{ x: -20, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: -20, opacity: 0 }}
        transition={{ duration: 0.2 }}
      >
        {header}
        {content}
      </motion.div>
    )
  }

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
        {header}
        {content}
      </motion.div>
    </motion.div>
  )
}
