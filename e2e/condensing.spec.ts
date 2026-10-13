import { expect, test, type Page } from '@playwright/test'
import { openApp, runSql } from './editor'

/*
 * Condensing (docs/UX.md#playback, ADR 0041): a long trace plays in about 30
 * seconds, with repetitive stretches as one step each, which a visitor can
 * expand, step through and collapse again. The result follows the player
 * throughout.
 */

function viz(page: Page) {
  return page.getByTestId('visualization')
}

function control(page: Page, name: string) {
  return page.getByTestId('player').getByRole('button', { name, exact: true })
}

/** The step counter's numbers: [position, steps]. */
async function stepCounter(page: Page): Promise<[number, number]> {
  const text = (await page.getByTestId('viz-step').textContent()) ?? ''
  const match = text.replace(/,/g, '').match(/step (\d+) \/ (\d+)/)
  return [Number(match?.[1]), Number(match?.[2])]
}

/** How many result rows the results pane says have arrived. */
async function rowsSoFar(page: Page): Promise<number> {
  const text = (await page.getByTestId('rows-filling').textContent()) ?? ''
  return Number(text.replace(/,/g, '').match(/: (\d+) of/)?.[1])
}

test('example 2 plays condensed: a stretch of pages expands into its steps, and collapses again', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM order_items WHERE product_id = 42;')
  await expect(viz(page)).toBeVisible()
  await control(page, 'Pause').click()
  await control(page, 'To the start').click()

  // 2,747 events in at most 900 steps: 30 seconds at the default 30 steps a second.
  const player = page.getByTestId('player')
  await expect(player).toHaveAttribute('data-events', '2747')
  const steps = Number(await player.getAttribute('data-steps'))
  expect(steps).toBeLessThanOrEqual(900)
  await expect(page.getByTestId('viz-events')).toHaveText('(2,747 events)')
  await expect(page.getByTestId('viz-caption')).toHaveText(
    `Ready to replay 2,747 events in ${steps} steps: repetitive stretches play as one step each, and any of them can be expanded. Press play, or step through them one at a time.`,
  )

  // The first pages play a step at a time; then a stretch of pages is one step.
  await control(page, 'Step forward').click()
  await control(page, 'Step forward').click()
  await expect(page.getByTestId('viz-caption')).toHaveText('Heap page 0 isn’t in shared buffers, so it’s read from disk into a buffer.')
  await expect(page.getByTestId('viz-stretch')).toHaveCount(0)
  const stretch = page.getByTestId('viz-stretch')
  for (let i = 0; i < 40 && (await stretch.count()) === 0; i++) await control(page, 'Step forward').click()
  await expect(stretch).toHaveAttribute('data-kind', 'stretch')
  const caption = page.getByTestId('viz-caption')
  await expect(caption).toHaveText(
    /^Heap pages? [\d,]+( to [\d,]+)?: [\d,]+ rows visible to the query, checked against the filter; (none pass|\d+ pass(es)?)\. Buffers: \d+ pages? read from disk into shared buffers\.$/,
  )
  const events = Number((await stretch.textContent())?.match(/stretch of (\d+) events/)?.[1])
  expect(events).toBeGreaterThan(1)
  const [at] = await stepCounter(page)
  const reads = await viz(page).getByTestId('viz-reads').textContent()

  // Expanded: its events, one step each, from the first; the steps grow by as many.
  await stretch.getByRole('button', { name: 'Expand' }).click()
  await expect(page.getByTestId('viz-step')).toHaveText(`step ${at} / ${steps + events - 1}`)
  await expect(stretch).toHaveAttribute('data-kind', 'expanded')
  await expect(stretch).toContainText(`event 1 of ${events} in an expanded stretch`)
  await expect(caption).toHaveText(/^Heap page [\d,]+ isn’t in shared buffers, so it’s read from disk into a buffer\.$/)
  for (let i = 2; i <= events; i++) {
    await control(page, 'Step forward').click()
    await expect(stretch).toContainText(`event ${i} of ${events} in an expanded stretch`)
  }
  // Its last event leaves the same state as the stretch did.
  await expect(viz(page).getByTestId('viz-reads')).toHaveText(reads ?? '')
  await expect(caption).toHaveText(/^Heap page [\d,]+: [\d,]+ rows visible to the query, checked against the filter/)

  await stretch.getByRole('button', { name: 'Collapse' }).click()
  await expect(page.getByTestId('viz-step')).toHaveText(`step ${at} / ${steps}`)
  await expect(stretch).toHaveAttribute('data-kind', 'stretch')
})

test('example 2’s matching rows still flash one at a time, and the result follows them back and forth', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM order_items WHERE product_id = 42;')
  await control(page, 'Pause').click()
  await control(page, 'To the start').click()
  await expect(page.getByTestId('rows-filling')).toContainText('0 of 189 so far')

  // Step on until the first row goes to the result: a step of its own.
  const caption = page.getByTestId('viz-caption')
  for (let i = 0; i < 200 && !/goes to the result as row 1\./.test((await caption.textContent()) ?? ''); i++) {
    await control(page, 'Step forward').click()
  }
  await expect(caption).toHaveText(/^Row \(\d+,\d+\) goes to the result as row 1\.$/)
  await expect(page.getByTestId('viz-stretch')).toHaveCount(0)
  await expect(page.getByTestId('rows-filling')).toContainText('1 of 189 so far')
  await expect(page.getByTestId('result-table').locator('tbody tr')).toHaveCount(1)
  // Stepping back over it takes the row away again.
  await control(page, 'Step back').click()
  await expect(page.getByTestId('rows-filling')).toContainText('0 of 189 so far')
})

test('example 12’s rows play condensed, a row a step; expanded, its row reaches the result at its emit', async ({ page }) => {
  await openApp(page)
  // 500 rows: too many to flash one by one in 900 steps, so each stretch carries its row.
  await runSql(page, 'SELECT * FROM orders WHERE id BETWEEN 1 AND 500;')
  await expect(viz(page)).toBeVisible()
  await control(page, 'Pause').click()
  const steps = Number(await page.getByTestId('player').getAttribute('data-steps'))
  expect(steps).toBeLessThanOrEqual(900)

  // Halfway: a stretch that sends a row to the result.
  await page.getByRole('slider', { name: 'Timeline' }).fill(String(Math.floor(steps / 2)))
  const stretch = page.getByTestId('viz-stretch')
  const caption = page.getByTestId('viz-caption')
  await expect(stretch).toHaveAttribute('data-kind', 'stretch')
  await expect(caption).toContainText(/goes? to the result: rows? [\d,]+/)
  const sent = await rowsSoFar(page)
  expect(sent).toBeGreaterThan(0)
  await expect(page.getByTestId('result-table').locator('tbody tr')).toHaveCount(sent)
  const resultRows = (await caption.textContent())?.match(/(\d+) rows? go(es)? to the result/)
  const inStretch = Number(resultRows?.[1])

  // Expanded, back at its first event: its rows haven't reached the result yet.
  await stretch.getByRole('button', { name: 'Expand' }).click()
  await expect(stretch).toHaveAttribute('data-kind', 'expanded')
  const events = Number((await stretch.textContent())?.match(/of (\d+) in an expanded stretch/)?.[1])
  await expect(page.getByTestId('rows-filling')).toContainText(`${sent - inStretch} of 500 so far`)
  // Stepping through it, they arrive one at a time, each at its emit.
  for (let i = 2; i <= events; i++) {
    await control(page, 'Step forward').click()
    const text = (await caption.textContent()) ?? ''
    const row = text.match(/goes to the result as row ([\d,]+)\./)?.[1]
    if (row !== undefined) {
      await expect(page.getByTestId('rows-filling')).toContainText(`${row} of 500 so far`)
      await expect(page.getByTestId('result-table').locator('tbody tr')).toHaveCount(Number(row.replace(/,/g, '')))
    }
  }
  await expect(page.getByTestId('rows-filling')).toContainText(`${sent} of 500 so far`)
  // Back over the whole stretch, its rows go again.
  for (let i = 1; i < events; i++) await control(page, 'Step back').click()
  await control(page, 'Step back').click()
  await expect(page.getByTestId('rows-filling')).toContainText(`${sent - inStretch} of 500 so far`)
})
