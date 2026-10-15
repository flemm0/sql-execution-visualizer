import { useMemo } from 'react'
import { nextEvent, type JumpTarget } from '../player/jump'
import { SPEEDS, type Player, type Speed } from '../player/usePlayer'
import type { Trace } from '../replay/trace'

const integer = new Intl.NumberFormat('en-US')

/**
 * The player's controls (docs/UX.md#playback): to the start, step back,
 * play/pause, step forward, to the end, a timeline scrubber, the speed,
 * autoplay, jumps to the next result row, page or plan node, and which
 * step is showing (and how many events the steps condense, when stretches
 * group them).
 */
export function PlayerControls({ player, trace }: { player: Player; trace: Trace }) {
  const { position, steps, playing } = player
  // Where each jump would land: the next such event not yet played, or null if none is left.
  const next = useMemo(
    () => new Map(JUMPS.map((jump) => [jump.target, nextEvent(trace, player.events, jump.target)])),
    [trace, player.events],
  )
  return (
    <div
      className="flex items-center gap-2 border-t border-line px-3 py-1.5"
      data-testid="player"
      data-steps={steps}
      data-events={player.totalEvents}
      data-events-done={player.events}
    >
      <button type="button" className="icon-btn" onClick={() => player.seek(0)} disabled={position === 0} aria-label="To the start">
        ⏮
      </button>
      <button type="button" className="icon-btn" onClick={player.stepBack} disabled={position === 0} aria-label="Step back">
        ◀
      </button>
      {playing ? (
        <button type="button" className="icon-btn" onClick={player.pause} aria-label="Pause">
          ⏸
        </button>
      ) : (
        <button type="button" className="icon-btn" onClick={player.play} aria-label="Play">
          ▶
        </button>
      )}
      <button type="button" className="icon-btn" onClick={player.stepForward} disabled={position === steps} aria-label="Step forward">
        ▶|
      </button>
      <button type="button" className="icon-btn" onClick={() => player.seek(steps)} disabled={position === steps} aria-label="To the end">
        ⏭
      </button>
      <span className="flex items-center gap-1 text-fg-muted" role="group" aria-label="Jump to the next">
        Next
        {JUMPS.map((jump) => {
          const event = next.get(jump.target) ?? null
          return (
            <button
              key={jump.target}
              type="button"
              className="btn text-xs"
              onClick={() => event !== null && player.jumpToEvent(event)}
              disabled={event === null}
              aria-label={jump.name}
              title={event === null ? `${jump.title} None is left.` : jump.title}
            >
              {jump.label}
            </button>
          )
        })}
      </span>
      <input
        type="range"
        className="min-w-24 flex-1 accent-index"
        min={0}
        max={steps}
        value={position}
        onChange={(event) => player.seek(Number(event.target.value))}
        aria-label="Timeline"
      />
      <label className="flex items-center gap-1.5 text-fg-muted">
        Speed
        <select
          className="rounded border border-line bg-surface-2 px-1 py-0.5 text-fg"
          value={String(player.speed)}
          onChange={(event) => player.setSpeed(parseSpeed(event.target.value))}
        >
          {SPEEDS.map((speed) => (
            <option key={speed} value={String(speed)}>
              {speed === 'instant' ? 'instant' : `${speed} steps/s`}
            </option>
          ))}
        </select>
      </label>
      <label
        className="flex items-center gap-1.5 text-fg-muted"
        title="Start each query's animation playing as soon as it runs. Turn off to have it wait, paused at step 0."
      >
        <input type="checkbox" checked={player.autoplay} onChange={(event) => player.setAutoplay(event.target.checked)} />
        Autoplay
      </label>
      <span className="font-mono text-fg-muted tabular-nums" data-testid="viz-step">
        step {integer.format(position)} / {integer.format(steps)}
      </span>
      {player.totalEvents > steps && (
        <span
          className="font-mono text-fg-muted tabular-nums"
          data-testid="viz-events"
          title="Repetitive stretches of the trace play as one step each, so the animation fits in about 30 seconds. Expand one to step through its events."
        >
          ({integer.format(player.totalEvents)} events)
        </span>
      )}
    </div>
  )
}

/** The jump-to-next controls, in the order they're shown. */
const JUMPS: { target: JumpTarget; label: string; name: string; title: string }[] = [
  { target: 'row', label: 'row', name: 'Next result row', title: 'Pause on the next row sent to the result.' },
  { target: 'page', label: 'page', name: 'Next page', title: 'Pause on the next page asked for in shared buffers: found there, or read from disk.' },
  { target: 'node', label: 'node', name: 'Next plan node', title: 'Pause where a plan node next starts or finishes (or a Limit stops the nodes below it).' },
]

function parseSpeed(value: string): Speed {
  return value === 'instant' ? 'instant' : Number(value)
}
