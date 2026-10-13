import { useEffect, useState } from 'react'
import { readSetting, saveSetting } from '../storage'
import { collapseStretch, eventsDone, expandStretch, isStretch, type Step } from './condense'
import { startOfTrace, type Speed } from './playback'

export type { Speed }

export const SPEEDS: Speed[] = [1, 3, 10, 30, 60, 'instant']
export const DEFAULT_SPEED: Speed = 30

/** Where the chosen speed is kept between visits (localStorage). */
const SPEED_KEY = 'player-speed'
/** Remembers whether autoplay is turned off ('off'); on unless turned off. */
const AUTOPLAY_KEY = 'player-autoplay'

function readSpeed(): Speed {
  const saved = readSetting(SPEED_KEY)
  if (saved === 'instant') return 'instant'
  const steps = Number(saved)
  return SPEEDS.includes(steps) ? steps : DEFAULT_SPEED
}

export interface Player {
  /** How many steps have happened, from 0 to `steps`. */
  position: number
  /** How many steps there are to play: the condensed steps, plus the events of any stretch expanded. */
  steps: number
  /** How many trace events have happened after `position` steps: what stateAt and the panes are given. */
  events: number
  /** How many events the trace has: more than `steps` when stretches condense them. */
  totalEvents: number
  /** The step that happened last; null at the start. */
  current: Step | null
  playing: boolean
  speed: Speed
  /** Whether a new trace starts playing by itself (remembered in this browser). */
  autoplay: boolean
  /** Starts a new trace's steps (see condense) where startOfTrace says: playing from step 0 with autoplay on, paused there with it off. */
  load: (steps: Step[]) => void
  play: () => void
  pause: () => void
  /** Moves to a step (clamped to the trace), playing on if it was playing. */
  seek: (position: number) => void
  stepForward: () => void
  stepBack: () => void
  setSpeed: (speed: Speed) => void
  setAutoplay: (autoplay: boolean) => void
  /** Expands the stretch just played into one step per event, and pauses on its first event. */
  expand: () => void
  /** Collapses the expanded stretch the current step is in back into one step, and pauses on it. */
  collapse: () => void
}

/**
 * Playback of a trace: the position, play and pause, the speed and autoplay
 * (both remembered in this browser). App owns the one player, so the
 * visualization and the results pane show the same step, and loads each
 * run's trace into it, which starts playing at once unless autoplay is off
 * (docs/UX.md#running-statements).
 */
export function usePlayer(): Player {
  const [speed, setSpeedState] = useState<Speed>(readSpeed)
  const [autoplay, setAutoplayState] = useState(() => readSetting(AUTOPLAY_KEY) !== 'off')
  const [list, setList] = useState<Step[]>([])
  const [position, setPosition] = useState(0)
  const steps = list.length
  const current = position > 0 ? (list[position - 1] ?? null) : null
  const [wantsToPlay, setWantsToPlay] = useState(true)
  // Playing stops by itself at the last step.
  const playing = wantsToPlay && position < steps

  useEffect(() => {
    if (!playing || speed === 'instant') return
    const timer = window.setInterval(() => {
      setPosition((current) => Math.min(current + 1, steps))
    }, 1000 / speed)
    // Called when playback stops or the speed changes, so only one timer ever runs.
    return () => window.clearInterval(timer)
  }, [playing, speed, steps])

  function clamp(to: number) {
    return Math.max(0, Math.min(to, steps))
  }

  return {
    position,
    steps,
    events: eventsDone(list, position),
    totalEvents: list.at(-1)?.end ?? 0,
    current,
    playing,
    speed,
    autoplay,
    load(newSteps) {
      const start = startOfTrace(newSteps.length, speed, autoplay)
      setList(newSteps)
      setPosition(start.position)
      setWantsToPlay(start.playing)
    },
    play() {
      // At the end, play starts over; at instant speed, it goes straight to the end.
      if (speed === 'instant') setPosition(steps)
      else if (position >= steps) setPosition(0)
      setWantsToPlay(true)
    },
    pause() {
      setWantsToPlay(false)
    },
    seek(to) {
      // Playing on only if it was: at the last step playback has stopped, so
      // going back from there (to the start, or with the timeline) stays paused.
      if (!playing) setWantsToPlay(false)
      setPosition(clamp(to))
    },
    stepForward() {
      setWantsToPlay(false)
      setPosition((current) => clamp(current + 1))
    },
    stepBack() {
      setWantsToPlay(false)
      setPosition((current) => clamp(current - 1))
    },
    setSpeed(next) {
      setSpeedState(next)
      saveSetting(SPEED_KEY, String(next))
      if (next === 'instant' && playing) setPosition(steps)
    },
    setAutoplay(next) {
      // Applies from the next run; what's loaded now keeps playing or stays paused.
      setAutoplayState(next)
      saveSetting(AUTOPLAY_KEY, next ? 'on' : 'off')
    },
    expand() {
      if (current === null || !isStretch(current)) return
      // The stretch's first event takes its place, so the step count stays where it was.
      setWantsToPlay(false)
      setList(expandStretch(list, position - 1))
    },
    collapse() {
      if (current?.stretch === undefined) return
      const collapsed = collapseStretch(list, position - 1)
      setWantsToPlay(false)
      setList(collapsed.steps)
      setPosition(collapsed.index + 1)
    },
  }
}
