import type { Listener } from "../types"
import { DJFace } from "./FaceGenerator"

interface Props {
  listeners: Listener[]
  ownerUid?: string
  currentUserId: string
  djUserIds: string[]
  isStationOwner: boolean
  onGrantDJ?: (userId: string) => void
  onRevokeDJ?: (userId: string) => void
}

export function ListenersPanel({ listeners, ownerUid, currentUserId, djUserIds, isStationOwner, onGrantDJ, onRevokeDJ }: Props) {
  if (listeners.length === 0) return null

  // Owner first, then alphabetical
  const sorted = [...listeners].sort((a, b) => {
    if (a.userId === ownerUid) return -1
    if (b.userId === ownerUid) return 1
    return a.displayName.localeCompare(b.displayName)
  })

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider">
        Listening now
      </div>
      <ul>
        {sorted.map(l => {
          const isOwner = l.userId === ownerUid
          const isDJ = djUserIds.includes(l.userId)
          const isYou = l.userId === currentUserId
          return (
            <li key={l.userId} className="flex items-center gap-3 px-4 py-2.5 border-b border-border/50 last:border-0">
              <DJFace uid={l.userId} size={32} />
              <div className="flex-1 min-w-0">
                <span className="text-sm text-white truncate block">
                  {l.displayName}
                  {isYou && <span className="text-muted text-xs font-normal ml-1.5">(you)</span>}
                </span>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {isOwner && (
                    <span className="text-xs text-amber-400/80 font-medium">owner</span>
                  )}
                  {isDJ && !isOwner && (
                    <span className="text-xs text-accent/80 font-medium">DJ</span>
                  )}
                </div>
              </div>
              {isStationOwner && !isOwner && !isYou && (
                isDJ ? (
                  <button
                    onClick={() => onRevokeDJ?.(l.userId)}
                    className="text-xs text-muted hover:text-red-400 transition-colors flex-shrink-0"
                  >
                    Revoke DJ
                  </button>
                ) : (
                  <button
                    onClick={() => onGrantDJ?.(l.userId)}
                    className="text-xs text-muted hover:text-accent transition-colors flex-shrink-0"
                  >
                    Make DJ
                  </button>
                )
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
