import { useState } from "react"
import { stationSocket } from "../services/partykit"

export function DJBreakTester() {
  const [message, setMessage] = useState("")

  const insert = () => {
    if (!message.trim()) return
    stationSocket.testDJBreak(message.trim())
    setMessage("")
  }

  return (
    <div className="fixed right-4 top-1/2 -translate-y-1/2 w-48 bg-panel border border-border rounded-xl p-3 flex flex-col gap-2 z-50 shadow-lg">
      <p className="text-xs text-muted font-medium uppercase tracking-wider">DJ Break Tester</p>
      <textarea
        value={message}
        onChange={e => setMessage(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); insert() } }}
        placeholder="Break message…"
        rows={3}
        className="w-full bg-surface border border-border rounded-lg px-2 py-1.5 text-xs text-white placeholder:text-muted/50 resize-none focus:outline-none focus:ring-1 focus:ring-accent"
      />
      <button
        onClick={insert}
        disabled={!message.trim()}
        className="w-full py-1.5 bg-accent hover:bg-accent-hover disabled:opacity-40 text-white text-xs font-semibold rounded-lg transition-colors"
      >
        Insert Break
      </button>
    </div>
  )
}
