import { useEffect, useState } from 'react'
import { readSetting, saveSetting } from '../storage'

/** Steps per second, or 'instant' to jump straight to the end. */
export type Speed = number | 'instant'

export const SPEEDS: Speed[] = [1, 3, 10, 30, 60, 'instant']
export const DEFAULT_SPEED: Speed = 30

/** Where the chosen speed is kept between visits (localStorage). */
const SPEED_KEY = 'player-speed'

function readSpeed(): Speed {
  const saved = readSetting(SPEED_KEY)
  if (saved === 'instant') return 'instant'
  const steps = Number(saved)
  return SPEEDS.includes(steps) ? steps : DEFAULT_SPEED
}

export interface Player {
  /** How many steps have happened, from 0 to `steps`. */
  position: number
  steps: number
  playing: boolean
  speed: Speed
  play: () => void
  pause: () => void
  /** Moves to a step (clamped to the trace), playing on if it was playing. */
  seek: (position: number) => void
  stepForward: () => void
  stepBack: () => void
  setSpeed: (speed: Speed) => void
}

/**
 * Playback of a trace of `steps` steps: the position, play and pause, and the
 * speed (remembered in this browser). It starts playing at once (autoplay,
 * docs/UX.md#running-statements). The component using it is keyed by run, so
 * every run starts a fresh player at step 0.
 */
export function usePlayer(steps: number): Player {
  const [speed, setSpeedState] = useState<Speed>(readSpeed)
  const [position, setPosition] = useState(() => (speed === 'instant' ? steps : 0))
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
    playing,
    speed,
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
  }
}
