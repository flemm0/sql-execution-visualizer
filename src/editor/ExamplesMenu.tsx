import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { Example } from '../examples'

interface ExamplesMenuProps {
  examples: Example[]
  /** Called with the example the visitor picks; the menu has closed by then. */
  onChoose: (example: Example) => void
}

/** Where the open menu sits on screen: under the button, its right edge lined up with the button's. */
interface Position {
  top: number
  right: number
}

/**
 * The editor toolbar's Examples ▾ button and its menu, following the WAI-ARIA
 * menu button pattern: Enter, Space or ↓ on the button opens the menu on its
 * first example (↑ on its last); in the menu ↑ ↓ Home End move, Enter or a
 * click picks, and Esc closes it and goes back to the button. Tab or a click
 * outside closes it too.
 *
 * The pane's title bar clips anything that overflows it, so the open menu is
 * drawn into <body> (a React portal) and placed under the button with fixed
 * positioning.
 */
export function ExamplesMenu({ examples, onChoose }: ExamplesMenuProps) {
  const [position, setPosition] = useState<Position | null>(null)
  const open = position !== null
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const items = useRef<(HTMLButtonElement | null)[]>([])
  // Which item to focus once the menu is on screen.
  const [focusIndex, setFocusIndex] = useState(0)
  // A unique id for linking the button to its menu (aria-controls).
  const menuId = useId()

  function openMenu(focus: number) {
    const rect = button.current?.getBoundingClientRect()
    if (!rect) return
    setFocusIndex(focus)
    setPosition({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
  }

  function close(returnFocus: boolean) {
    setPosition(null)
    if (returnFocus) button.current?.focus()
  }

  function choose(example: Example) {
    setPosition(null)
    onChoose(example)
  }

  // Focus moves into the menu once it has rendered.
  useEffect(() => {
    if (open) items.current[focusIndex]?.focus()
  }, [open, focusIndex])

  // A click anywhere outside the menu or the button closes it; so does resizing the window, which would move the button.
  useEffect(() => {
    if (!open) return
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (!menu.current?.contains(target) && !button.current?.contains(target)) setPosition(null)
    }
    function onResize() {
      setPosition(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onResize)
    }
  }, [open])

  function onButtonKeyDown(event: KeyboardEvent) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu(event.key === 'ArrowDown' ? 0 : examples.length - 1)
    }
  }

  function onMenuKeyDown(event: KeyboardEvent) {
    const current = items.current.findIndex((item) => item === document.activeElement)
    const last = examples.length - 1
    const moves: Record<string, number> = {
      ArrowDown: current === last ? 0 : current + 1,
      ArrowUp: current <= 0 ? last : current - 1,
      Home: 0,
      End: last,
    }
    if (event.key in moves) {
      event.preventDefault()
      setFocusIndex(moves[event.key])
      items.current[moves[event.key]]?.focus()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'Tab') {
      // The menu lives at the end of the page, so tabbing on from it would leave the toolbar: back to the button.
      event.preventDefault()
      close(true)
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn text-xs whitespace-nowrap"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        // Enter and Space click a button, so they open it here too, on the first example.
        onClick={() => (open ? close(false) : openMenu(0))}
        onKeyDown={onButtonKeyDown}
        title="Load a ready-made example into the editor"
      >
        Examples <span aria-hidden="true">▾</span>
      </button>
      {position &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Examples"
            className="fixed z-50 flex max-h-[70vh] w-[26rem] flex-col overflow-y-auto rounded-md border border-line-strong bg-surface-1 py-1 shadow-lg"
            style={{ top: position.top, right: position.right }}
            onKeyDown={onMenuKeyDown}
          >
            {examples.map((example, index) => (
              <button
                key={example.id}
                ref={(element) => {
                  items.current[index] = element
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                // Read out as its title, with the description as extra detail.
                aria-labelledby={`${menuId}-${example.id}-title`}
                aria-describedby={`${menuId}-${example.id}-description`}
                className="flex gap-2 px-3 py-1.5 text-left outline-none hover:bg-surface-2 focus:bg-surface-2"
                onClick={() => choose(example)}
              >
                <span className="w-5 shrink-0 text-right font-mono text-xs text-fg-muted">{example.id}</span>
                <span className="min-w-0">
                  <span id={`${menuId}-${example.id}-title`} className="block text-fg">
                    {example.title}
                  </span>
                  <span id={`${menuId}-${example.id}-description`} className="block text-xs text-fg-muted">
                    {example.description}
                  </span>
                </span>
              </button>
            ))}
            <p className="mt-1 border-t border-line px-3 pt-1.5 pb-1 text-xs text-fg-muted">
              Picking one replaces the editor’s text; Cmd/Ctrl+Z brings yours back. Nothing runs until you press Run.
            </p>
          </div>,
          document.body,
        )}
    </>
  )
}
