import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { GLOSSARY, nodeTypeTerm, type GlossaryTerm } from './glossary'

/** How long the definition stays after the pointer leaves, so it can move onto the definition itself. */
const HIDE_DELAY_MS = 150
/** Space between the term and its definition, and the least between the definition and the window's edge. */
const GAP = 6

/**
 * A real Postgres term with its glossary definition (ADR 0040): a dotted
 * underline in the surrounding text's color, and the definition in a small
 * box while the pointer is over it or it has keyboard focus. Escape closes
 * it. Screen readers get the definition as the term's description.
 *
 * `children` is the text shown, when it differs from the term ("est." for
 * "estimated rows"); by default, the term itself.
 */
export function Term({ term, children }: { term: GlossaryTerm; children?: ReactNode }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)
  const tooltip = useRef<HTMLDivElement>(null)
  const hideTimer = useRef<number | undefined>(undefined)

  function show() {
    window.clearTimeout(hideTimer.current)
    setOpen(true)
  }
  function hideSoon() {
    window.clearTimeout(hideTimer.current)
    hideTimer.current = window.setTimeout(() => setOpen(false), HIDE_DELAY_MS)
  }
  function hide() {
    window.clearTimeout(hideTimer.current)
    setOpen(false)
  }

  // Shows the definition in the top layer (a popover), so no pane's scrolling or edges cut it off.
  useLayoutEffect(() => {
    const box = tooltip.current
    const term = anchor.current
    if (box === null || term === null) return
    if (!open) {
      if (box.matches(':popover-open')) box.hidePopover()
      return
    }
    if (!box.matches(':popover-open')) box.showPopover()
    const place = () => placeBelowOrAbove(box, term)
    place()
    // Escape closes it wherever focus is; scrolling a pane moves it with the term.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  useEffect(() => () => window.clearTimeout(hideTimer.current), [])

  return (
    <>
      <span
        ref={anchor}
        className="term"
        // Focusable, so keyboard users can reach the definition too.
        tabIndex={0}
        aria-describedby={id}
        data-term={term}
        onMouseEnter={show}
        onMouseLeave={hideSoon}
        onFocus={show}
        onBlur={hide}
        // Inside a <label>, a click would toggle its checkbox; on a term it only shows the definition.
        onClick={(event) => event.preventDefault()}
      >
        {children ?? term}
      </span>
      {/*
        Rendered into <body>, not here: the definition's text would otherwise
        become part of the text around the term (a checkbox's name, a line's
        text). Always in the page, hidden when closed, so aria-describedby
        can point at it.
      */}
      {createPortal(
        <div
          ref={tooltip}
          id={id}
          role="tooltip"
          popover="manual"
          className="term-tooltip"
          data-testid="glossary-tooltip"
          onMouseEnter={show}
          onMouseLeave={hideSoon}
        >
          <span className="font-semibold">{term}</span>: {GLOSSARY[term]}
        </div>,
        document.body,
      )}
    </>
  )
}

/** Puts the box under the term, or over it when there's no room below, within the window. */
export function placeBelowOrAbove(box: HTMLElement, term: HTMLElement) {
  const at = term.getBoundingClientRect()
  const size = box.getBoundingClientRect()
  const left = Math.min(Math.max(GAP, at.left), window.innerWidth - size.width - GAP)
  const below = at.bottom + GAP
  const top = below + size.height <= window.innerHeight - GAP ? below : Math.max(GAP, at.top - GAP - size.height)
  box.style.left = `${left}px`
  box.style.top = `${top}px`
}

/**
 * A plan node's heading, e.g. "Index Scan using orders_pkey on orders", with
 * its node type marked as a term when the glossary defines it.
 */
export function NodeTitle({ title, nodeType }: { title: string; nodeType: string }) {
  const term = nodeTypeTerm(title, nodeType)
  if (term === null) return <>{title}</>
  return (
    <>
      <Term term={term} />
      {title.slice(term.length)}
    </>
  )
}
