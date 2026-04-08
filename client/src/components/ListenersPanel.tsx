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
      <div className="px-4 py-3 flex flex-wrap gap-2">
        {sorted.map(l => {
          const isOwner = l.userId === ownerUid
          const isDJ = djUserIds.includes(l.userId)
          const isYou = l.userId === currentUserId
          const canManage = isStationOwner && !isOwner && !isYou

          return (
            <div key={l.userId} className="relative group">
              <DJFace uid={l.userId} size={36} />

              {/* Hover tooltip */}
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 bg-surface border border-border rounded-lg whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity z-20 text-center">
                <p className="text-white text-xs font-medium">{l.displayName}</p>
                {(isOwner || isDJ || isYou) && (
                  <p className="text-muted text-[10px] mt-0.5">
                    {isOwner ? "owner" : isDJ ? "DJ" : "you"}
                  </p>
                )}
                {canManage && (
                  isDJ ? (
                    <button
                      onClick={() => onRevokeDJ?.(l.userId)}
                      className="text-[10px] text-red-400 hover:text-red-300 mt-1 block w-full transition-colors"
                    >
                      Revoke DJ
                    </button>
                  ) : (
                    <button
                      onClick={() => onGrantDJ?.(l.userId)}
                      className="text-[10px] text-accent hover:text-white mt-1 block w-full transition-colors"
                    >
                      Make DJ
                    </button>
                  )
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
