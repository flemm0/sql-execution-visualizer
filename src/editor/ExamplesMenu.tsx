import { useId, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { EXAMPLES, type Example } from '../examples'

/** Space between the button and the menu, and the least between the menu and the window's edge. */
const GAP = 6

/**
 * The editor toolbar's Examples menu (ADR 0041): one item per example, its
 * number, concept and what to watch for. Choosing one calls `onChoose`, which
 * loads it into the editor; nothing runs until the visitor presses Run.
 *
 * The keyboard follows the WAI-ARIA menu button pattern: Enter, Space or ↓
 * on the button opens the menu at its first item, ↑ at its last; ↑ ↓ Home
 * End move between items; Enter or Space chooses; Escape closes it and
 * returns to the button; Tab or a click elsewhere closes it.
 */
export function ExamplesMenu({ onChoose }: { onChoose: (example: Example) => void }) {
  // Closed, or open with focus starting on its first or last item.
  const [open, setOpen] = useState<'closed' | 'first' | 'last'>('closed')
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  // The items' elements, in order, filled in by their `ref` callbacks.
  const items = useRef<(HTMLButtonElement | null)[]>([])
  const menuId = useId()

  // Shows the menu in the top layer (a popover), so the editor pane's edges don't cut it off,
  // under the button, and moves focus into it.
  useLayoutEffect(() => {
    const box = menu.current
    const anchor = button.current
    if (box === null || anchor === null) return
    if (open === 'closed') {
      if (box.matches(':popover-open')) box.hidePopover()
      return
    }
    if (!box.matches(':popover-open')) box.showPopover()
    const place = () => placeBelow(box, anchor)
    place()
    items.current[open === 'first' ? 0 : EXAMPLES.length - 1]?.focus()
    // A click anywhere but the menu or its button closes it (the button closes it itself).
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node
      if (!box.contains(target) && !anchor.contains(target)) setOpen('closed')
    }
    // The panes' resize handles (react-resizable-panels) watch the pointer on the whole document
    // and find a handle by its position, so where the menu covers one, they would take a click
    // meant for an item. They ignore events whose default action was prevented, and a listener
    // on the window in the capture phase runs before theirs, so the menu claims its own here.
    const shield = (event: PointerEvent) => {
      if (box.contains(event.target as Node)) event.preventDefault()
    }
    window.addEventListener('pointerdown', shield, true)
    window.addEventListener('pointermove', shield, true)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('pointerdown', shield, true)
      window.removeEventListener('pointermove', shield, true)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', place)
    }
  }, [open])

  function close(returnFocus: boolean) {
    setOpen('closed')
    if (returnFocus) button.current?.focus()
  }

  function choose(example: Example) {
    setOpen('closed')
    // onChoose moves focus to the editor, with the example in it.
    onChoose(example)
  }

  function onButtonKeyDown(event: KeyboardEvent) {
    // Enter and Space click the button, which opens the menu at its first item.
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(event.key === 'ArrowDown' ? 'first' : 'last')
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const current = items.current.findIndex((item) => item === document.activeElement)
    const count = EXAMPLES.length
    const moves: Record<string, number> = {
      ArrowDown: (current + 1) % count,
      ArrowUp: (current - 1 + count) % count,
      Home: 0,
      End: count - 1,
    }
    if (event.key in moves) {
      event.preventDefault()
      items.current[moves[event.key]]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    }
    // Tab moves focus on as usual, and the menu closes as focus leaves it (onMenuBlur).
  }

  // Focus moving to something outside the menu (Tab) closes it. Clicks are left to the
  // pointerdown listener above: some browsers don't focus a clicked button, so a click
  // on an item would otherwise close the menu before the item gets it.
  function onMenuBlur(event: FocusEvent) {
    const to = event.relatedTarget
    if (!(to instanceof Node) || menu.current?.contains(to) || button.current?.contains(to)) return
    close(false)
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn text-xs whitespace-nowrap"
        aria-haspopup="menu"
        aria-expanded={open !== 'closed'}
        aria-controls={menuId}
        onClick={() => setOpen((current) => (current === 'closed' ? 'first' : 'closed'))}
        onKeyDown={onButtonKeyDown}
        title="Load a ready-made example into the editor"
      >
        Examples <span aria-hidden="true">▾</span>
      </button>
      <div
        ref={menu}
        id={menuId}
        popover="manual"
        role="menu"
        aria-label="Examples"
        className="examples-menu"
        data-testid="examples-menu"
        onKeyDown={onMenuKeyDown}
        onBlur={onMenuBlur}
      >
        {EXAMPLES.map((example, index) => (
          <button
            key={example.number}
            ref={(element) => {
              items.current[index] = element
            }}
            type="button"
            role="menuitem"
            // One tab stop for the whole menu: the arrow keys move between items.
            tabIndex={-1}
            className="examples-menu-item"
            aria-label={`${example.number}. ${example.title}`}
            aria-describedby={`${menuId}-${example.number}`}
            onClick={() => choose(example)}
          >
            <span className="w-5 shrink-0 text-right font-mono text-fg-muted">{example.number}</span>
            <span className="min-w-0">
              <span className="block font-medium">{example.title}</span>
              <span id={`${menuId}-${example.number}`} className="block text-xs text-fg-muted">
                {example.description}
              </span>
            </span>
          </button>
        ))}
        <p className="border-t border-line px-2 pt-1.5 pb-1 text-xs text-fg-muted">
          An example replaces the editor’s text (Cmd/Ctrl+Z brings yours back). Nothing runs until you press Run.
        </p>
      </div>
    </>
  )
}

/** Puts the menu under the button, within the window, no taller than the room below. */
function placeBelow(box: HTMLElement, anchor: HTMLElement) {
  const at = anchor.getBoundingClientRect()
  const width = box.getBoundingClientRect().width
  const top = at.bottom + GAP
  box.style.left = `${Math.min(Math.max(GAP, at.left), window.innerWidth - width - GAP)}px`
  box.style.top = `${top}px`
  box.style.maxHeight = `${window.innerHeight - top - GAP}px`
}
