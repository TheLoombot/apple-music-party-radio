import { useEffect, useRef, useState } from "react"
import type { ChatMessage, AppUser } from "../types"

interface Props {
  messages: ChatMessage[]
  currentUser: AppUser
  onSend: (text: string) => void
}

export function StationChat({ messages, currentUser, onSend }: Props) {
  const [input, setInput] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleSend = () => {
    const text = input.trim()
    if (!text) return
    onSend(text)
    setInput("")
  }

  return (
    <div className="bg-panel rounded-xl overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-border text-xs text-muted font-medium uppercase tracking-wider">
        Chat
      </div>

      <div ref={scrollRef} className="h-64 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 ? (
          <p className="text-muted text-xs text-center pt-4">No messages yet. Say something!</p>
        ) : (
          messages.map(msg => {
            const isMe = msg.userId === currentUser.uid
            return (
              <div key={msg.id} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                <span className="text-muted/60 text-xs mb-0.5">{msg.displayName}</span>
                <div className={`px-3 py-1.5 rounded-2xl text-sm max-w-[80%] break-words ${
                  isMe ? "bg-accent text-white rounded-tr-sm" : "bg-surface text-white rounded-tl-sm"
                }`}>
                  {msg.text}
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="px-3 py-3 border-t border-border flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleSend() } }}
          placeholder="Say something…"
          className="flex-1 bg-surface text-white placeholder-muted rounded-xl px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim()}
          className="px-3 py-2 rounded-xl bg-accent text-white text-sm font-medium disabled:opacity-30 hover:bg-accent-hover transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  )
}
