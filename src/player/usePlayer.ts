import { useEffect, useState } from 'react'
import { readSetting, saveSetting } from '../storage'
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
  steps: number
  playing: boolean
  speed: Speed
  /** Whether a new trace starts playing by itself (remembered in this browser). */
  autoplay: boolean
  /** Starts a new trace of `steps` steps where startOfTrace says: playing from step 0 with autoplay on, paused there with it off. */
  load: (steps: number) => void
  play: () => void
  pause: () => void
  /** Moves to a step (clamped to the trace), playing on if it was playing. */
  seek: (position: number) => void
  stepForward: () => void
  stepBack: () => void
  setSpeed: (speed: Speed) => void
  setAutoplay: (autoplay: boolean) => void
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
  const [steps, setSteps] = useState(0)
  const [position, setPosition] = useState(0)
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
    autoplay,
    load(newSteps) {
      const start = startOfTrace(newSteps, speed, autoplay)
      setSteps(newSteps)
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
  }
}
