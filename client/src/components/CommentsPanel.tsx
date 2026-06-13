import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { AnimatePresence, motion } from "framer-motion"
import { X, Send, ArrowDown } from "lucide-react"
import { DJFace } from "./FaceGenerator"
import { Tooltip } from "./Tooltip"
import type { Listener, LogEntry, UserLogEntry, Visit, AppUser } from "../types"


const MAX_MESSAGE_LENGTH = 256
const MAX_RECENT_VISITORS = 25
const RECENT_VISITOR_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Scroll slack (px) within which we still consider the list "at bottom". */
const AT_BOTTOM_SLACK = 40

interface Props {
  onClose: () => void
  listeners: Listener[]
  log: LogEntry[]
  visits: Visit[]
  currentUser: AppUser
  ownerUid?: string
  djUserIds: string[]
  isStationOwner: boolean
  onPostMessage: (text: string) => void
  onGrantDJ?: (userId: string) => void
  onRevokeDJ?: (userId: string) => void
  mode?: "modal" | "panel"
}

/** A run of consecutive messages from the same user, rendered under one avatar. */
interface MessageGroup {
  kind: "user"
  userId: string
  displayName: string
  entries: UserLogEntry[]
}

type LogRow = MessageGroup | { kind: "track"; entry: Extract<LogEntry, { kind: "track" }> }

interface SelectedUser {
  userId: string
  displayName: string
}

/** Station chat panel. Presence strip on top (present listeners full-opacity,
 *  recent visitors faded), chronological message log below with track-change
 *  dividers, input at the bottom. Tapping an avatar opens a member card with
 *  role badges and the owner's Make/Revoke DJ control. */
export function CommentsPanel({
  onClose, listeners, log, visits, currentUser,
  ownerUid, djUserIds, isStationOwner,
  onPostMessage, onGrantDJ, onRevokeDJ,
  mode = "modal",
}: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  // Local draft. Cleared on submit.
  const [draft, setDraft] = useState("")
  const [inputFocused, setInputFocused] = useState(false)
  const [selected, setSelected] = useState<SelectedUser | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // ─── Presence strip data ──────────────────────────────────────────────────
  const presentSorted = useMemo(() => {
    const sorted = [...listeners].sort((a, b) => a.displayName.localeCompare(b.displayName))
    // Current user first so you can always find yourself.
    return sorted.sort((a, b) => Number(b.userId === currentUser.uid) - Number(a.userId === currentUser.uid))
  }, [listeners, currentUser.uid])

  const recentVisitors = useMemo(() => {
    const presentIds = new Set(listeners.map(l => l.userId))
    const cutoff = Date.now() - RECENT_VISITOR_MAX_AGE_MS
    return visits
      .filter(v => !presentIds.has(v.userId) && v.lastSeenAt >= cutoff)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, MAX_RECENT_VISITORS)
  }, [visits, listeners])

  // ─── Log rows: group consecutive same-user messages, pass dividers through ─
  const rows = useMemo<LogRow[]>(() => {
    const out: LogRow[] = []
    for (const entry of log) {
      if (entry.kind === "track") {
        out.push({ kind: "track", entry })
        continue
      }
      const last = out[out.length - 1]
      if (last?.kind === "user" && last.userId === entry.userId) {
        last.entries.push(entry)
        // Latest message wins the group's display name (covers renames).
        last.displayName = entry.displayName
      } else {
        out.push({ kind: "user", userId: entry.userId, displayName: entry.displayName, entries: [entry] })
      }
    }
    return out
  }, [log])

  // ─── Stick-to-bottom scrolling ────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null)
  const atBottomRef = useRef(true)
  const [showNewPill, setShowNewPill] = useState(false)

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_SLACK
    atBottomRef.current = atBottom
    if (atBottom) setShowNewPill(false)
  }

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    atBottomRef.current = true
    setShowNewPill(false)
  }

  // On new tail entry: follow if pinned to the bottom, otherwise surface the pill.
  const lastEntryId = log[log.length - 1]?.id
  useLayoutEffect(() => {
    if (!lastEntryId) return
    if (atBottomRef.current) scrollToBottom()
    else setShowNewPill(true)
  }, [lastEntryId])

  const submit = () => {
    const text = draft.trim().slice(0, MAX_MESSAGE_LENGTH)
    if (!text) return
    onPostMessage(text)
    setDraft("")
    // Posting always rejoins the conversation at the bottom.
    scrollToBottom()
  }

  const remaining = MAX_MESSAGE_LENGTH - draft.length

  // ─── Presence strip + member card ─────────────────────────────────────────
  // inline-block so the wrapper shrink-wraps the avatar; the Tooltip portals
  // its label, so it escapes the presence row's overflow-x-auto clipping.
  const avatarButton = (userId: string, displayName: string, present: boolean) => (
    <Tooltip key={userId} label={displayName} position="bottom" className="inline-block">
      <button
        onClick={() => setSelected(s => s?.userId === userId ? null : { userId, displayName })}
        aria-label={displayName}
        className={`flex-shrink-0 rounded-lg transition ${present ? "" : "opacity-40 hover:opacity-70"} ${
          selected?.userId === userId ? "ring-2 ring-accent ring-offset-2 ring-offset-panel" : ""
        }`}
      >
        <DJFace uid={userId} size={44} />
      </button>
    </Tooltip>
  )

  const header = (
    <div className="px-3 py-2.5 border-b border-border flex items-center gap-2 flex-shrink-0">
      <div className="flex-1 flex items-center gap-1.5 overflow-x-auto min-w-0 p-1.5 -m-1.5">
        {presentSorted.map(l => avatarButton(l.userId, l.displayName, true))}
        {recentVisitors.length > 0 && (
          <div className="w-px h-8 bg-border mx-1 flex-shrink-0" aria-hidden />
        )}
        {recentVisitors.map(v => avatarButton(v.userId, v.displayName, false))}
      </div>
      <button onClick={onClose} className="text-muted hover:text-white transition-colors w-10 h-10 flex items-center justify-center flex-shrink-0">
        <X size={18} />
      </button>
    </div>
  )

  const memberCard = selected && (() => {
    const isOwner = selected.userId === ownerUid
    const isDJ = djUserIds.includes(selected.userId)
    const isYou = selected.userId === currentUser.uid
    const isPresent = listeners.some(l => l.userId === selected.userId)
    return (
      <div className="px-4 py-3 border-b border-border flex items-center gap-3 flex-shrink-0 bg-zinc-800/80 shadow-inner">
        <DJFace uid={selected.userId} size={72} />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-white truncate">
            {selected.displayName}
            {isYou && <span className="text-muted/60 ml-1.5">(you)</span>}
          </div>
          <div className="flex items-center gap-1.5">
            {isOwner && <span className="text-[10px] text-amber-400/80 font-medium uppercase tracking-wider">owner</span>}
            {isDJ && !isOwner && <span className="text-[10px] text-accent/80 font-medium uppercase tracking-wider">DJ</span>}
            {!isPresent && <span className="text-[10px] text-muted/60 uppercase tracking-wider">away</span>}
          </div>
        </div>
        {isStationOwner && !isOwner && !isYou && (
          <button
            onClick={() => (isDJ ? onRevokeDJ : onGrantDJ)?.(selected.userId)}
            className={`text-xs flex-shrink-0 py-1 px-2 rounded transition-colors ${
              isDJ ? "text-muted hover:text-red-400" : "text-muted hover:text-accent"
            }`}
          >
            {isDJ ? "Revoke DJ" : "Make DJ"}
          </button>
        )}
      </div>
    )
  })()

  // ─── Message log ──────────────────────────────────────────────────────────
  // Own messages sit on the right (texting convention): avatar on the right,
  // bubble tail and sharp corner mirrored to point back at it.
  const bubble = (entry: UserLogEntry, first: boolean, own: boolean) => (
    <div key={entry.id} className={`relative max-w-full ${first ? "mt-2" : "mt-1.5"}`}>
      {first && (
        /* Speech bubble tail — small triangle nub pointing back at the avatar. */
        <span
          aria-hidden
          className={`absolute top-3 ${own ? "-right-1.5" : "-left-1.5"}`}
          style={{
            width: 0,
            height: 0,
            borderTop: "6px solid transparent",
            borderBottom: "6px solid transparent",
            ...(own ? { borderLeft: "8px solid #1a1a1a" } : { borderRight: "8px solid #1a1a1a" }),
          }}
        />
      )}
      <div className={`bg-surface rounded-2xl px-4 py-2.5 ${first ? (own ? "rounded-tr-sm" : "rounded-tl-sm") : ""}`}>
        <p className="text-lg text-white font-medium break-words whitespace-pre-wrap leading-snug text-left">{entry.text}</p>
      </div>
    </div>
  )

  const list = (
    <div className="flex-1 relative min-h-0">
      <div ref={scrollRef} onScroll={handleScroll} className="h-full overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-6 text-center text-muted text-sm">It's quiet in here. Say something…</div>
        ) : (
          <ul>
            <AnimatePresence initial={false}>
              {rows.map(row => {
                if (row.kind === "track") {
                  return (
                    <motion.li
                      key={row.entry.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.22 }}
                      className="flex items-center gap-3 px-4 py-2.5"
                    >
                      <div className="flex-1 h-px bg-border/60" aria-hidden />
                      <span className="text-xs text-muted truncate max-w-[85%] flex-shrink-0">
                        ♪ {row.entry.title} — {row.entry.artist}
                      </span>
                      <div className="flex-1 h-px bg-border/60" aria-hidden />
                    </motion.li>
                  )
                }
                const own = row.userId === currentUser.uid
                return (
                  <motion.li
                    key={row.entries[0].id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.22 }}
                    className={`flex items-start gap-4 px-4 py-3 ${own ? "flex-row-reverse" : ""}`}
                  >
                    <DJFace uid={row.userId} size={96} />
                    <div className={`flex-1 min-w-0 flex flex-col ${own ? "items-end" : "items-start"}`}>
                      <div className="text-xs text-muted/80 truncate max-w-full">{row.displayName}</div>
                      {row.entries.map((entry, i) => bubble(entry, i === 0, own))}
                    </div>
                  </motion.li>
                )
              })}
            </AnimatePresence>
          </ul>
        )}
      </div>
      <AnimatePresence>
        {showNewPill && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            onClick={scrollToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-accent text-white text-xs font-semibold rounded-full px-3 py-1.5 shadow-lg"
          >
            New messages <ArrowDown size={13} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )

  const input = (
    <div className="border-t border-border p-3 flex-shrink-0">
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={draft}
          onChange={e => setDraft(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit() } }}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder="Say something…"
          className="flex-1 bg-surface text-white placeholder-muted rounded-lg px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          onClick={submit}
          aria-label="Send message"
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
        /* In-flow side panel — lives inside its 400px slot. Sticky so it
         *  stays pinned near the top as the page scrolls. */
        className="w-full sticky top-0 bg-panel rounded-xl overflow-hidden flex flex-col h-[calc(100vh-2rem)]"
        initial={{ x: 20, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 20, opacity: 0 }}
        transition={{ duration: 0.2 }}
      >
        {header}
        {memberCard}
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
        {memberCard}
        {list}
        {input}
      </motion.div>
    </motion.div>
  )
}
