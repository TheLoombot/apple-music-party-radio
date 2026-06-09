import { useEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { X, Send } from "lucide-react"
import { DJFace } from "./FaceGenerator"
import type { Listener, Comment, Visit, AppUser } from "../types"

const MAX_COMMENT_LENGTH = 256
const MAX_RECENT_USERS = 25

interface Props {
  onClose: () => void
  listeners: Listener[]
  comments: Comment[]
  visits: Visit[]
  currentUser: AppUser
  ownerUid?: string
  djUserIds: string[]
  isStationOwner: boolean
  onPostComment: (text: string) => void
  onGrantDJ?: (userId: string) => void
  onRevokeDJ?: (userId: string) => void
  mode?: "modal" | "panel"
}

interface Row {
  userId: string
  displayName: string
  comment?: Comment
  isPresent: boolean
}

/** Combined "now listening" + per-user comment panel. Each user has at most
 *  one comment at a time. Present users are at the top (sorted by comment
 *  recency, then alphabetical for users without a comment). Up to 25
 *  not-currently-present recent commenters appear below. The current user
 *  edits their own comment via the input at the bottom. */
export function CommentsPanel({
  onClose, listeners, comments, visits, currentUser,
  ownerUid, djUserIds, isStationOwner,
  onPostComment, onGrantDJ, onRevokeDJ,
  mode = "modal",
}: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  const myComment = useMemo(
    () => comments.find(c => c.userId === currentUser.uid),
    [comments, currentUser.uid]
  )

  // Local draft. Cleared on submit. Empty by default — the user's currently
  // committed comment is already visible in their row in the list.
  const [draft, setDraft] = useState("")
  const [inputFocused, setInputFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const rows = useMemo<Row[]>(() => {
    const commentByUser = new Map<string, Comment>(comments.map(c => [c.userId, c]))
    const visitByUser = new Map<string, Visit>(visits.map(v => [v.userId, v]))
    const presentIds = new Set(listeners.map(l => l.userId))

    // Present section — every connected listener, with their comment if any.
    const present: Row[] = listeners.map(l => ({
      userId: l.userId,
      displayName: l.displayName,
      comment: commentByUser.get(l.userId),
      isPresent: true,
    }))
    present.sort((a, b) => {
      if (a.comment && !b.comment) return -1
      if (!a.comment && b.comment) return 1
      if (a.comment && b.comment) return b.comment.postedAt - a.comment.postedAt
      return a.displayName.localeCompare(b.displayName)
    })

    // Recent section — union of commenters and past visitors who aren't
    // currently here. Recency is the comment's postedAt if they commented,
    // otherwise the visit's lastSeenAt (when they entered or left).
    const recentByUser = new Map<string, { displayName: string; comment?: Comment; recency: number }>()
    for (const c of comments) {
      if (presentIds.has(c.userId)) continue
      recentByUser.set(c.userId, { displayName: c.displayName, comment: c, recency: c.postedAt })
    }
    for (const v of visits) {
      if (presentIds.has(v.userId)) continue
      const existing = recentByUser.get(v.userId)
      if (existing) {
        // User has both a comment and a visit. Keep the comment but use a
        // visit-bumped displayName if it's newer (covers rename-on-rejoin).
        existing.displayName = v.displayName
      } else {
        recentByUser.set(v.userId, { displayName: v.displayName, recency: v.lastSeenAt })
      }
    }
    const recent: Row[] = [...recentByUser.entries()]
      .map(([userId, r]) => ({
        userId,
        displayName: r.displayName,
        comment: r.comment,
        isPresent: false,
        recency: r.recency,
      }))
      .sort((a, b) => (b as any).recency - (a as any).recency)
      .slice(0, MAX_RECENT_USERS)
      .map(({ recency: _r, ...rest }: any) => rest as Row)

    return [...present, ...recent]
  }, [listeners, comments, visits])

  const submit = () => {
    const text = draft.trim().slice(0, MAX_COMMENT_LENGTH)
    // Empty submit clears the user's current comment (server-side strips
    // any entry with this userId from `comments`). If they have nothing
    // to clear, no-op rather than spamming the socket.
    if (!text && !myComment) return
    onPostComment(text)
    setDraft("")
    // Drop keyboard focus so mobile soft keyboards dismiss and the focus
    // ring goes away on desktop.
    inputRef.current?.blur()
  }

  const remaining = MAX_COMMENT_LENGTH - draft.length

  const header = (
    <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
      <span className="text-xs text-muted font-medium uppercase tracking-wider">Listening Now</span>
      <button onClick={onClose} className="text-muted hover:text-white transition-colors w-10 h-10 flex items-center justify-center flex-shrink-0">
        <X size={18} />
      </button>
    </div>
  )

  const list = (
    <div className="flex-1 overflow-y-auto min-h-0">
      {rows.length === 0 ? (
        <div className="p-6 text-center text-muted text-sm">Nobody here yet.</div>
      ) : (
        <ul>
          <AnimatePresence initial={false}>
            {rows.map(row => {
              const isOwner = row.userId === ownerUid
              const isDJ = djUserIds.includes(row.userId)
              const isYou = row.userId === currentUser.uid
              return (
                <motion.li
                  key={row.userId}
                  layout
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: row.isPresent ? 1 : 0.4, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22 }}
                  className="flex items-start gap-4 px-4 py-4 border-b border-border/50 last:border-0"
                >
                  <DJFace uid={row.userId} size={96} />
                  <div className="flex-1 min-w-0">
                    {/* Header row — name + role badges on the left, the
                     *  Make/Revoke DJ control right-justified. Keeps the
                     *  bubble area below free to use the full column width. */}
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-muted/80 truncate">
                        {row.displayName}
                        {isYou && <span className="text-muted/60 ml-1.5">(you)</span>}
                      </span>
                      {isOwner && <span className="text-[10px] text-amber-400/80 font-medium uppercase tracking-wider">owner</span>}
                      {isDJ && !isOwner && <span className="text-[10px] text-accent/80 font-medium uppercase tracking-wider">DJ</span>}
                      {isStationOwner && !isOwner && !isYou && (
                        <button
                          onClick={() => (isDJ ? onRevokeDJ : onGrantDJ)?.(row.userId)}
                          className={`ml-auto text-xs flex-shrink-0 py-1 px-2 rounded transition-colors ${
                            isDJ
                              ? "text-muted hover:text-red-400"
                              : "text-muted hover:text-accent"
                          }`}
                        >
                          {isDJ ? "Revoke DJ" : "Make DJ"}
                        </button>
                      )}
                    </div>
                    {row.comment && (
                      /* Speech bubble — sharp top-left "tail" anchor + a small
                       *  triangle nub pointing back at the avatar. */
                      <div className="relative inline-block max-w-full mt-2">
                        <span
                          aria-hidden
                          className="absolute -left-1.5 top-3"
                          style={{
                            width: 0,
                            height: 0,
                            borderTop: "6px solid transparent",
                            borderBottom: "6px solid transparent",
                            borderRight: "8px solid #1a1a1a",
                          }}
                        />
                        <div className="bg-surface rounded-2xl rounded-tl-sm px-4 py-2.5">
                          <p className="text-lg text-white font-medium break-words whitespace-pre-wrap leading-snug">{row.comment.text}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </motion.li>
              )
            })}
          </AnimatePresence>
        </ul>
      )}
    </div>
  )

  const input = (
    <div className="border-t border-border p-3 flex-shrink-0">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value.slice(0, MAX_COMMENT_LENGTH))}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit() } }}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          maxLength={MAX_COMMENT_LENGTH}
          placeholder={myComment ? "Replace your comment…" : "Say something…"}
          className="flex-1 bg-surface text-white placeholder-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          onClick={submit}
          aria-label="Post comment"
          className="btn-3d w-10 h-10 rounded-lg flex items-center justify-center text-white"
        >
          <Send size={16} />
        </button>
      </div>
      {/* Char counter shows only while the input is active. Reserve the
       *  vertical slot so the input doesn't jump when focus changes. */}
      <div className="text-xs text-muted/50 mt-1.5 px-1 h-4">
        {inputFocused && `${remaining} chars remaining`}
      </div>
    </div>
  )

  if (mode === "panel") {
    return (
      <motion.div
        className="w-[400px] flex-shrink-0 self-start sticky top-4 bg-panel rounded-xl overflow-hidden flex flex-col h-[calc(100vh-2rem)]"
        initial={{ x: 20, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 20, opacity: 0 }}
        transition={{ duration: 0.2 }}
      >
        {header}
        {list}
        {input}
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
        {list}
        {input}
      </motion.div>
    </motion.div>
  )
}
