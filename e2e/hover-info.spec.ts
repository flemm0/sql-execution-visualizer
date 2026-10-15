import { expect, test, type Page } from '@playwright/test'
import { openApp, runSql } from './editor'

/*
 * Hover info on the shared buffers slots and the heap mini-map
 * (docs/UX.md#visualization): pointing at a slot or a square, or focusing it,
 * shows what it stands for, as the step on screen has it.
 */

function viz(page: Page) {
  return page.getByTestId('visualization')
}

function control(page: Page, name: string) {
  return page.getByTestId('player').getByRole('button', { name, exact: true })
}

/** The hover info showing, wherever it is in the page. */
function shownInfo(page: Page) {
  return page.getByTestId('viz-hover-info').filter({ visible: true })
}

test('example 2: a buffer slot and a mini-map square say what they stand for, by pointer and by keyboard', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM order_items WHERE product_id = 42;')
  await control(page, 'Pause').click()
  await page.getByRole('slider', { name: 'Timeline' }).fill('300')

  // Shared buffers: each slot names its page in full, and how it got there.
  const slots = viz(page).getByTestId('viz-slot')
  const first = slots.first()
  const name = (await first.textContent()) ?? ''
  const block = Number(name.slice(1))
  await first.hover()
  await expect(shownInfo(page)).toHaveText(
    `Heap page ${block} of order_items. It wasn’t in shared buffers, so this query read it from disk into a buffer.`,
  )
  await page.mouse.move(0, 0)
  await expect(shownInfo(page)).toHaveCount(0)

  // One Tab stop for the slots; the arrow keys move along them, and the text is the slot's description.
  await expect(viz(page).locator('[data-testid="viz-slot"][tabindex="0"]')).toHaveCount(1)
  await first.focus()
  await page.keyboard.press('ArrowRight')
  const second = slots.nth(1)
  await expect(second).toBeFocused()
  await expect(second).toHaveAccessibleDescription(
    `Heap page ${block + 1} of order_items. It wasn’t in shared buffers, so this query read it from disk into a buffer.`,
  )
  await page.keyboard.press('Escape')
  await expect(shownInfo(page)).toHaveCount(0)

  // The heap mini-map: 1,278 pages, 3 to a square; the first square counts its pages by what they went through.
  const square = viz(page).getByTestId('viz-minimap').getByRole('img', { name: 'heap pages 0 to 2', exact: true })
  await square.hover()
  await expect(shownInfo(page)).toHaveText(/^Heap pages 0 to 2: (\d read, (gave rows to the result|no rows to the result so far)(; )?)+\.$/)
  // A square the scan hasn't reached yet.
  const last = viz(page).getByTestId('viz-minimap').getByRole('img', { name: 'heap pages 1,275 to 1,277', exact: true })
  await last.hover()
  await expect(shownInfo(page)).toHaveText('Heap pages 1,275 to 1,277: 3 not read so far.')
})

test('a page asked for twice says so: one read from disk, one hit', async ({ page }) => {
  await openApp(page)
  // Example 12 as an Index Scan: the rows of customers 100 to 300 are scattered, so heap pages come up again.
  await runSql(page, 'SET enable_bitmapscan = off; SET enable_seqscan = off; SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300;')
  await control(page, 'Pause').click()
  await control(page, 'To the end').click()
  const slots = viz(page).getByTestId('viz-slot')
  let found = false
  for (let i = 0; i < (await slots.count()) && !found; i++) {
    await slots.nth(i).focus()
    found = /Asked for twice so far: 1 read from disk, 1 hit\.$/.test((await shownInfo(page).textContent()) ?? '')
  }
  expect(found).toBe(true)
  await runSql(page, 'RESET ALL;')
})
