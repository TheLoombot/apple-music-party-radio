import { useRef, useState, type ReactNode } from "react"
import {
  useFloating, autoUpdate, offset, flip, shift,
  useHover, useFocus, useDismiss, useRole, useInteractions, useTransitionStyles,
  FloatingPortal, type Placement,
} from "@floating-ui/react"

interface Props {
  children: ReactNode
  label: string
  /** Tailwind classes for the wrapper — forward flex/grid sizing (e.g. flex-1,
   *  flex-shrink-0), or "inline-block" to shrink-wrap. Defaults to a block div
   *  so a `w-full` child fills its grid/flex cell (the NowPlaying control grids
   *  rely on this — don't make the wrapper inline). */
  className?: string
  /** Preferred placement. floating-ui flips/shifts it to stay on-screen. */
  position?: "top" | "bottom"
  align?: "start" | "center" | "end"
}

/** Hover/focus/long-press tooltip, portaled so it escapes `overflow` clipping
 *  (replaces the old CSS-only Tooltip + CommentsPanel's PortalTooltip).
 *
 *  - Desktop (mouse): opens on hover after a short delay; keyboard focus opens
 *    it too (`useFocus` is :focus-visible-only, so a touch tap that merely
 *    focuses the button does NOT flash it).
 *  - Touch (no hover): a ~450ms long-press opens it; a normal tap falls through
 *    to the child's action. After a long-press fires we swallow the synthetic
 *    click so reading the label never also triggers the button.
 *
 *  Positioning is collision-aware (flip/shift) and follows the anchor via
 *  autoUpdate, so the manual `align`/`position` anti-clip juggling is gone —
 *  the props are now just a preferred placement. */
export function Tooltip({ children, label, className, position = "top", align = "center" }: Props) {
  const placement = (align === "center" ? position : `${position}-${align}`) as Placement
  const [open, setOpen] = useState(false)

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    whileElementsMounted: autoUpdate,
    middleware: [offset(6), flip(), shift({ padding: 8 })],
  })

  const hover = useHover(context, { mouseOnly: true, move: false, delay: { open: 250, close: 0 } })
  const focus = useFocus(context)          // visibleOnly: true by default → keyboard focus, not touch
  const dismiss = useDismiss(context)
  const role = useRole(context, { role: "tooltip" })
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, focus, dismiss, role])
  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, { duration: 120 })

  // ── Touch long-press (no hover on touch). Opens after a hold; the ensuing
  //    synthetic click is swallowed so the label can be read without firing the
  //    button. A quick tap never starts the timer, so taps still act normally.
  const pressTimer = useRef<ReturnType<typeof setTimeout>>()
  const longPressed = useRef(false)
  const startX = useRef(0)
  const startY = useRef(0)
  const clearPress = () => { if (pressTimer.current) clearTimeout(pressTimer.current) }
  const longPress = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse") return
      longPressed.current = false
      startX.current = e.clientX
      startY.current = e.clientY
      clearPress()
      pressTimer.current = setTimeout(() => { longPressed.current = true; setOpen(true) }, 450)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (Math.hypot(e.clientX - startX.current, e.clientY - startY.current) > 10) clearPress()
    },
    onPointerUp: clearPress,
    onPointerCancel: clearPress,
    onPointerLeave: clearPress,
    // Capture phase: cancel the click that follows a long-press before it
    // reaches the child button.
    onClickCapture: (e: React.MouseEvent) => {
      if (longPressed.current) { e.preventDefault(); e.stopPropagation(); longPressed.current = false }
    },
  }

  return (
    <div ref={refs.setReference} {...getReferenceProps(longPress)} className={className}>
      {children}
      {isMounted && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={{ ...floatingStyles, ...transitionStyles }}
            {...getFloatingProps()}
            className="z-[100] px-2 py-1 bg-surface border border-border rounded-lg whitespace-nowrap text-xs text-white pointer-events-none"
          >
            {label}
          </div>
        </FloatingPortal>
      )}
    </div>
  )
}
