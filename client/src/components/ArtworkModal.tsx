import { useEffect } from "react"
import { motion } from "framer-motion"

interface Props {
  src: string
  alt: string
  onClose: () => void
}

export function ArtworkModal({ src, alt, onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose() }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [onClose])

  return (
    <motion.div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/80 cursor-pointer"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={e => { e.stopPropagation(); onClose() }}
    >
      <motion.img
        src={src}
        alt={alt}
        className="max-w-[min(90vw,90vh)] max-h-[min(90vw,90vh)] object-contain rounded-xl shadow-2xl"
        initial={{ scale: 0.92, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.92, opacity: 0 }}
        transition={{ duration: 0.2 }}
      />
    </motion.div>
  )
}
