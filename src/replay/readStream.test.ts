import { describe, expect, it } from 'vitest'
import { unusedReadAhead } from './readStream'

/*
 * What a read stream counts when a scan stops early, against what PGlite's
 * Postgres reported for `SELECT * FROM order_items LIMIT n` (a Seq Scan of
 * pages 0 to 1,277, about 157 rows a page), as buffer hits plus reads.
 */

const PAGES = Array.from({ length: 1278 }, (_, block) => block)

/** Every page the stream counts when the scan takes the first `consumed`. */
function counted(consumed: number, cached: (block: number) => boolean) {
  return consumed + unusedReadAhead(PAGES, cached, consumed).length
}

describe('a read stream stopped early', () => {
  it('on an empty cache, reads in batches of 1, 2, 4, 8, then 16 pages, each when the scan reaches its first page', () => {
    const cold = () => false
    // [scan's pages, pages Postgres read]: LIMIT 1, 200, 400, 500, 1000, 1200, 2000, 2500, 5000, and a Filter that stops on page 570.
    const measured = [
      [1, 1],
      [2, 3],
      [3, 3],
      [4, 7],
      [7, 7],
      [8, 15],
      [13, 15],
      [16, 31],
      [32, 47],
      [571, 575],
    ]
    for (const [consumed, reads] of measured) expect(counted(consumed, cold), `${consumed} pages`).toBe(reads)
    // The unused pages are the rest of the last batch: pages 4 to 6 after a stop on page 3.
    expect(unusedReadAhead(PAGES, cold, 4)).toEqual([4, 5, 6])
  })

  it('on a warm cache, pins one page ahead: a hit the scan never uses', () => {
    const warm = () => true
    for (const consumed of [1, 2, 7, 20]) expect(counted(consumed, warm)).toBe(consumed + 1)
    expect(unusedReadAhead(PAGES, warm, 7)).toEqual([7])
  })

  it('with the first 10 pages cached, starts reading in batches when it reaches the first that isn’t', () => {
    const firstTen = (block: number) => block < 10
    // LIMIT 1000, 1600, 1800, 3000 and 5000: hits plus reads.
    const measured = [
      [7, 8],
      [11, 11],
      [12, 13],
      [20, 25],
      [32, 41],
    ]
    for (const [consumed, pages] of measured) expect(counted(consumed, firstTen), `${consumed} pages`).toBe(pages)
  })

  it('with pages 20 to 39 cached: pins cached pages ahead as hits, shrinks its look-ahead over them, then ramps up again', () => {
    const middle = (block: number) => block >= 20 && block < 40
    // [scan's pages, hits plus reads], from LIMIT 3141 to 17114.
    const measured = [
      [21, 29],
      [25, 31],
      [30, 34],
      [38, 39],
      [40, 40],
      [41, 52],
      [50, 52],
      [60, 68],
      [70, 84],
      [90, 100],
      [110, 116],
    ]
    for (const [consumed, pages] of measured) expect(counted(consumed, middle), `${consumed} pages`).toBe(pages)
  })

  it('a scan that reads to the end counts each page once', () => {
    expect(unusedReadAhead(PAGES, () => false, PAGES.length)).toEqual([])
    expect(unusedReadAhead(PAGES, (block) => block % 3 === 0, PAGES.length)).toEqual([])
  })
})
