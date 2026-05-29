import type { ReactNode } from "react"

interface Props {
  children: ReactNode
  label: string
  /** Tailwind classes for the wrapper — use to forward flex sizing (e.g. flex-1, flex-shrink-0). */
  className?: string
  /** Where to anchor the tooltip relative to the children. Default "top". */
  position?: "top" | "bottom"
  /** Horizontal alignment of the tooltip. Default "center". Use "start"/"end" if the
   *  centered tooltip would clip against a panel/modal edge. */
  align?: "start" | "center" | "end"
}

/** A hover/focus-revealed tooltip overlay. Same pattern as the album-art tooltip in
 *  the station browser — pure CSS, fades in on hover, no JS, no native title-attribute
 *  delay. Each Tooltip uses a uniquely-scoped `group/tip-<id>` so siblings don't
 *  cross-trigger each other. */
export function Tooltip({ children, label, className, position = "top", align = "center" }: Props) {
  const v = position === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
  const h =
    align === "start" ? "left-0" :
    align === "end"   ? "right-0" :
                        "left-1/2 -translate-x-1/2"
  return (
    <div className={`relative group/tip ${className ?? ""}`}>
      {children}
      <div
        role="tooltip"
        className={`absolute ${v} ${h} px-2 py-1 bg-surface border border-border rounded-lg whitespace-nowrap opacity-0 pointer-events-none group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 transition-opacity z-[60] text-xs text-white`}
      >
        {label}
      </div>
    </div>
  )
}
