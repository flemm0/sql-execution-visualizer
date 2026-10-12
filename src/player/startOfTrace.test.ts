import { describe, expect, it } from 'vitest'
import { startOfTrace } from './playback'

describe('startOfTrace', () => {
  it('with autoplay on, plays from step 0, or at instant speed starts at the end', () => {
    expect(startOfTrace(120, 30, true)).toEqual({ position: 0, playing: true })
    expect(startOfTrace(120, 'instant', true)).toEqual({ position: 120, playing: true })
  })

  it('with autoplay off, waits paused at step 0, whatever the speed', () => {
    expect(startOfTrace(120, 30, false)).toEqual({ position: 0, playing: false })
    expect(startOfTrace(120, 'instant', false)).toEqual({ position: 0, playing: false })
  })
})
