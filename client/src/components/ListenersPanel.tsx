import { MessageCircle } from "lucide-react"
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
  onOpenChat?: () => void
  unreadCount?: number
}

export function ListenersPanel({ listeners, ownerUid, currentUserId, djUserIds, isStationOwner, onGrantDJ, onRevokeDJ, onOpenChat, unreadCount }: Props) {
  if (listeners.length === 0 && !onOpenChat) return null

  // Owner first, then alphabetical
  const sorted = [...listeners].sort((a, b) => {
    if (a.userId === ownerUid) return -1
    if (b.userId === ownerUid) return 1
    return a.displayName.localeCompare(b.displayName)
  })

  return (
    <div className="bg-panel rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider flex items-center justify-between">
        <span>Listening now</span>
        {onOpenChat && (
          <div className="relative">
            <button
              onClick={onOpenChat}
              className="text-muted hover:text-white transition-colors w-8 h-8 flex items-center justify-center"
              title="Chat"
            >
              <MessageCircle size={16} />
            </button>
            {(unreadCount ?? 0) > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] bg-accent rounded-full text-[9px] font-bold text-white flex items-center justify-center px-0.5 leading-none pointer-events-none">
                {unreadCount! > 9 ? "9+" : unreadCount}
              </span>
            )}
          </div>
        )}
      </div>
      {sorted.length > 0 && <ul>
        {sorted.map(l => {
          const isOwner = l.userId === ownerUid
          const isDJ = djUserIds.includes(l.userId)
          const isYou = l.userId === currentUserId
          return (
            <li key={l.userId} className="flex items-center gap-3 px-4 py-2.5 border-b border-border/50 last:border-0">
              <DJFace uid={l.userId} size={64} />
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
                    className="text-xs text-muted hover:text-red-400 transition-colors flex-shrink-0 py-2 px-2.5 rounded-lg"
                  >
                    Revoke DJ
                  </button>
                ) : (
                  <button
                    onClick={() => onGrantDJ?.(l.userId)}
                    className="text-xs text-muted hover:text-accent transition-colors flex-shrink-0 py-2 px-2.5 rounded-lg"
                  >
                    Make DJ
                  </button>
                )
              )}
            </li>
          )
        })}
      </ul>}
    </div>
  )
}
