import { useEffect, useState } from "react"
import { motion } from "framer-motion"
import { X } from "lucide-react"
import { FaceGenerator, faceConfigFromUID, type FaceConfig } from "./FaceGenerator"
import { getFaceConfig } from "../services/identity"
import type { AppUser } from "../types"

interface Props {
  user: AppUser
  /** Persist the edited identity. Called with the trimmed name + chosen face. */
  onSave: (displayName: string, faceConfig: FaceConfig) => void
  onClose: () => void
}

/** The user's profile surface: edit DJ name + avatar (via the face studio).
 *  Edits are drafts until Save — the avatar is seeded with the user's current
 *  face (their saved custom one, else their deterministic uid-face), so editing
 *  tweaks rather than starts from random. */
export function ProfileModal({ user, onSave, onClose }: Props) {
  const [name, setName] = useState(user.displayName)
  const [face, setFace] = useState<FaceConfig>(() => getFaceConfig() ?? faceConfigFromUID(user.uid))

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  const save = () => {
    onSave(name.trim() || user.displayName, face)
    onClose()
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
        className="w-full sm:max-w-lg bg-panel rounded-t-2xl sm:rounded-2xl overflow-hidden flex flex-col h-[85vh]"
        initial={{ y: 40, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 40, opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border flex items-center justify-end flex-shrink-0">
          <button onClick={onClose} aria-label="Close" className="text-muted hover:text-white transition-colors w-10 h-10 flex items-center justify-center flex-shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {/* DJ name */}
          <div>
            <input
              id="dj-name"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") save() }}
              maxLength={64}
              placeholder="What's your DJ name?"
              className="w-full bg-surface border border-border rounded-lg px-3 py-2.5 text-white placeholder:text-muted/50 focus:outline-none focus:border-accent"
            />
          </div>

          {/* Avatar — the existing face studio, controlled by the draft */}
          <FaceGenerator value={face} onChange={setFace} />
        </div>

        <div className="px-4 py-3 border-t border-border flex gap-2 flex-shrink-0">
          <button
            onClick={onClose}
            className="flex-1 bg-surface hover:bg-border text-muted hover:text-white font-semibold py-2.5 rounded-xl transition-colors text-sm"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="flex-1 bg-accent hover:bg-accent-hover text-white font-semibold py-2.5 rounded-xl transition-colors text-sm"
          >
            Save
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
