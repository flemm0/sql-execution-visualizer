import { expect, test, type Page } from '@playwright/test'
import { openApp, runSql } from './editor'

/*
 * Jump-to-next controls (docs/UX.md#playback, ADR 0043): Next row, page and
 * node pause on the next row sent to the result, page asked for in shared
 * buffers, or plan node starting or finishing, expanding the stretch it's in,
 * and collapsing the one they leave.
 */

function control(page: Page, name: string) {
  return page.getByTestId('player').getByRole('button', { name, exact: true })
}

/** The step counter's numbers: [position, steps]. */
async function stepCounter(page: Page): Promise<[number, number]> {
  const text = (await page.getByTestId('viz-step').textContent()) ?? ''
  const match = text.replace(/,/g, '').match(/step (\d+) \/ (\d+)/)
  return [Number(match?.[1]), Number(match?.[2])]
}

test('example 2: Next row pauses on each row sent to the result, and Next node on the scan starting and finishing', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM order_items WHERE product_id = 42;')
  await control(page, 'Pause').click()
  await control(page, 'To the start').click()
  const caption = page.getByTestId('viz-caption')

  await control(page, 'Next result row').click()
  await expect(caption).toHaveText(/^Row \(\d+,\d+\) goes to the result as row 1\.$/)
  await expect(page.getByTestId('rows-filling')).toContainText('1 of 189 so far')
  await expect(control(page, 'Play')).toBeVisible()
  await control(page, 'Next result row').click()
  await expect(caption).toHaveText(/^Row \(\d+,\d+\) goes to the result as row 2\.$/)
  await expect(page.getByTestId('result-table').locator('tbody tr')).toHaveCount(2)

  await control(page, 'To the start').click()
  await control(page, 'Next plan node').click()
  await expect(caption).toHaveText('Seq Scan on order_items starts.')
  await control(page, 'Next plan node').click()
  await expect(caption).toHaveText('Seq Scan on order_items has no more rows: it sent 189 rows to the result.')
  // At the end, there's nothing left to jump to.
  for (const name of ['Next result row', 'Next page', 'Next plan node']) await expect(control(page, name)).toBeDisabled()
})

test('example 2: Next page goes into stretches page by page, collapsing each one it leaves', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM order_items WHERE product_id = 42;')
  await control(page, 'Pause').click()
  await control(page, 'To the start').click()
  const [, steps] = await stepCounter(page)
  const caption = page.getByTestId('viz-caption')
  const stretch = page.getByTestId('viz-stretch')

  // Every page, in order, past the early detail and into the stretches.
  for (let block = 0; block < 30; block++) {
    await control(page, 'Next page').click()
    await expect(caption).toHaveText(`Heap page ${block} isn’t in shared buffers, so it’s read from disk into a buffer.`)
  }
  // Inside a stretch, expanded; the one before was collapsed again, so at most one is.
  await expect(stretch).toHaveAttribute('data-kind', 'expanded')
  const events = Number((await stretch.textContent())?.match(/of (\d+) in an expanded stretch/)?.[1])
  expect((await stepCounter(page))[1]).toBe(steps + events - 1)
  expect(Number(await page.getByTestId('player').getAttribute('data-events-done'))).toBeGreaterThan(30)
})

test('example 4: Next row reaches rows inside stretches, one expanded at a time', async ({ page }) => {
  await openApp(page)
  // 1,001 rows: each stretch carries its rows, so a jump has to expand one.
  await runSql(page, 'SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000;')
  await control(page, 'Pause').click()
  await control(page, 'To the start').click()
  const [, steps] = await stepCounter(page)
  const caption = page.getByTestId('viz-caption')
  const stretch = page.getByTestId('viz-stretch')
  for (let row = 1; row <= 30; row++) {
    await control(page, 'Next result row').click()
    await expect(caption).toHaveText(new RegExp(`^Row \\(\\d+,\\d+\\) goes to the result as row ${row}\\.$`))
    await expect(page.getByTestId('rows-filling')).toContainText(`${row} of 1,001 so far`)
  }
  await expect(stretch).toHaveAttribute('data-kind', 'expanded')
  const events = Number((await stretch.textContent())?.match(/of (\d+) in an expanded stretch/)?.[1])
  expect((await stepCounter(page))[1]).toBe(steps + events - 1)
})
