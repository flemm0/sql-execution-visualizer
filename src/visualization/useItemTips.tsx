import { useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { placeBelowOrAbove } from '../glossary/Term'

/** What each item of the list spreads onto its element (see useItemTips). */
export interface ItemTipProps {
  ref: (element: HTMLElement | null) => void
  tabIndex: number
  'aria-describedby': string | undefined
  onMouseEnter: () => void
  onMouseLeave: () => void
  onFocus: () => void
  onBlur: (event: FocusEvent<HTMLElement>) => void
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

/**
 * Hover info for a row of small items, such as buffer slots or mini-map
 * squares (docs/UX.md#visualization). An item's text shows in a tooltip like
 * a glossary term's (ADR 0040) while the pointer is over it or it has focus;
 * a tap on a touch screen focuses it. The list is one Tab stop: the arrow
 * keys, Home and End move between its items, and Escape hides the tooltip.
 * Screen readers get the text as the focused item's description.
 *
 * `describe(i)` gives item i's text; it's called only for the item showing.
 * Spread `itemProps(i)` onto item i, and render `tip` once, anywhere.
 */
export function useItemTips(count: number, describe: (item: number) => ReactNode): { itemProps: (item: number) => ItemTipProps; tip: ReactNode } {
  const id = useId()
  // The item whose text shows, if any.
  const [shown, setShown] = useState<number | null>(null)
  // The item Tab reaches: the last one focused.
  const [tabStop, setTabStop] = useState(0)
  const elements = useRef<(HTMLElement | null)[]>([])
  const box = useRef<HTMLDivElement>(null)
  const showing = shown !== null && shown < count ? shown : null
  const stop = Math.min(tabStop, Math.max(0, count - 1))

  // Shows the text in the top layer (a popover), next to the item, so no pane's edges cut it off.
  // No dependency list: it runs after every render, as the item's text and place change with each step.
  useLayoutEffect(() => {
    const tooltip = box.current
    if (tooltip === null) return
    const anchor = showing === null ? null : elements.current[showing]
    if (anchor === null || anchor === undefined) {
      if (tooltip.matches(':popover-open')) tooltip.hidePopover()
      return
    }
    if (!tooltip.matches(':popover-open')) tooltip.showPopover()
    const place = () => placeBelowOrAbove(tooltip, anchor)
    place()
    // Scrolling a pane moves it with the item.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  })

  function focus(item: number) {
    const target = Math.max(0, Math.min(item, count - 1))
    elements.current[target]?.focus()
  }

  function itemProps(item: number): ItemTipProps {
    return {
      ref: (element) => {
        elements.current[item] = element
      },
      tabIndex: item === stop ? 0 : -1,
      'aria-describedby': item === showing ? id : undefined,
      onMouseEnter: () => setShown(item),
      onMouseLeave: () => setShown((current) => (current === item && document.activeElement !== elements.current[item] ? null : current)),
      onFocus: () => {
        setTabStop(item)
        setShown(item)
      },
      onBlur: () => setShown((current) => (current === item ? null : current)),
      onKeyDown: (event) => {
        const moves: Record<string, number> = { ArrowLeft: item - 1, ArrowUp: item - 1, ArrowRight: item + 1, ArrowDown: item + 1, Home: 0, End: count - 1 }
        if (event.key in moves) {
          event.preventDefault()
          focus(moves[event.key])
        } else if (event.key === 'Escape') {
          setShown(null)
        }
      },
    }
  }

  const tip = createPortal(
    <div ref={box} id={id} role="tooltip" popover="manual" className="term-tooltip" data-testid="viz-hover-info">
      {showing === null ? null : describe(showing)}
    </div>,
    document.body,
  )
  return { itemProps, tip }
}
