import { expect, test, type Page } from '@playwright/test'
import { openApp, runSql, waitForRunToFinish } from './editor'
import { clickTreePath } from './schemaTree'

/*
 * Show internals (docs/UX.md#visualization): a checkbox in the visualization
 * pane's title bar that adds line pointers, tuple headers, visibility map
 * bits and B-tree high keys to the animation and the page browser.
 */

function toggle(page: Page) {
  return page.getByRole('checkbox', { name: 'Show internals' })
}

function viz(page: Page) {
  return page.getByTestId('visualization')
}

/** The player at the last step: "step 15 / 15". */
const atTheEnd = /^step ([\d,]+) \/ \1$/

function highKeys(page: Page) {
  return viz(page).locator('[data-testid="viz-btree-cell"][data-kind="highKey"] text')
}

test('off by default; on, an Index Scan shows the row’s tuple header, its page’s map bits and the high keys; off hides them again', async ({ page }) => {
  await openApp(page)
  await expect(toggle(page)).not.toBeChecked()
  await runSql(page, 'SELECT * FROM orders WHERE id = 4242;')
  await expect(page.getByTestId('viz-step')).toHaveText('step 11 / 11')
  // Off: the visualization as it always was.
  await expect(viz(page).getByTestId('viz-heap-internals')).toHaveCount(0)
  await expect(viz(page).getByTestId('internals-lp')).toHaveCount(0)
  await expect(highKeys(page)).toHaveCount(0)

  await toggle(page).check()
  const heapPage = viz(page).getByTestId('viz-heap-internals')
  await expect(heapPage.getByTestId('internals-header')).toHaveText(
    /^\d+ line pointers · free space from byte \d+ \(pd_lower\) to [\d,]+ \(pd_upper\)$/,
  )
  await expect(heapPage.getByTestId('internals-vm')).toHaveText(/^visibility map: all-visible 1 · all-frozen [01]$/)
  const lp = viz(page).getByTestId('viz-heap-row').getByTestId('internals-lp')
  await expect(lp).toHaveAttribute('data-state', 'normal')
  await expect(lp).toContainText(/^lp \d+: tuple at byte [\d,]+, \d+ bytes/)
  await expect(lp.getByTestId('internals-xmin')).toHaveText(/^xmin \d+$/)
  await expect(lp.getByTestId('internals-xmax')).toHaveText('xmax 0')
  await expect(lp.getByTestId('internals-infomask')).toContainText(/^infomask 0x[0-9a-f]{4} infomask2 0x[0-9a-f]{4} .*HEAP_XMIN_COMMITTED/)
  // The root is the only page on its level: no high key. The leaf's is the next leaf's first key.
  await expect(highKeys(page)).toHaveText(['HK +∞', /^HK \d+$/])

  await toggle(page).uncheck()
  await expect(viz(page).getByTestId('viz-heap-internals')).toHaveCount(0)
  await expect(viz(page).getByTestId('internals-lp')).toHaveCount(0)
  await expect(highKeys(page)).toHaveCount(0)
})

test('the setting is remembered after a reload, and applies to the page browser', async ({ page }) => {
  await openApp(page)
  await toggle(page).check()
  await page.reload()
  await openApp(page)
  await expect(toggle(page)).toBeChecked()

  // A table page: each line pointer with its tuple header, and the page's header and map bits.
  await clickTreePath(page, ['orders'])
  const browser = page.getByTestId('page-browser')
  await expect(browser.getByTestId('page-internals').getByTestId('internals-vm')).toHaveText(
    /^visibility map: all-visible 1 · all-frozen [01]$/,
  )
  const first = browser.getByTestId('page-row').first()
  await expect(first.getByTestId('internals-lp')).toContainText(/^lp 1: tuple at byte [\d,]+, \d+ bytes · xmin \d+ · xmax 0 · t_ctid \(0,1\)/)

  // An index page: its high key.
  await clickTreePath(page, ['orders', 'Indexes', 'orders_pkey'])
  await expect(browser.getByTestId('page-high-key')).toHaveText('no high key: the rightmost page on its level has no upper bound')
  await browser.getByTestId('index-item').first().getByRole('button').click()
  await expect(browser.getByTestId('page-high-key')).toHaveText(/^high key \(item 1\): \d+, the upper bound of the keys on this page$/)

  await toggle(page).uncheck()
  await expect(browser.getByTestId('page-high-key')).toHaveCount(0)
  await page.reload()
  await openApp(page)
  await expect(toggle(page)).not.toBeChecked()
})

test('a Seq Scan shows each page’s header; an Index Only Scan shows the map bits of the pages it didn’t read', async ({ page }) => {
  await openApp(page)
  await toggle(page).check()
  // Example 11: the Seq Scan reads categories' one page, and sends row 3 to the result.
  await runSql(page, 'SELECT * FROM categories WHERE id = 3;')
  await waitForRunToFinish(page)
  await expect(page.getByTestId('viz-step')).toHaveText(atTheEnd)
  await expect(viz(page).getByTestId('viz-heap-internals').getByTestId('internals-header')).toHaveText(/^12 line pointers · /)
  const lp = viz(page).getByTestId('viz-heap-row').getByTestId('internals-lp')
  await expect(lp).toContainText(/^lp 3: tuple at byte [\d,]+, \d+ bytes · xmin \d+ · xmax 0 · t_ctid \(0,3\)/)

  await runSql(page, 'SELECT order_date FROM orders WHERE customer_id = 42;')
  await waitForRunToFinish(page)
  await expect(page.getByTestId('viz-step')).toHaveText(atTheEnd)
  const internals = viz(page).getByTestId('viz-heap-internals')
  await expect(internals).toContainText('not read by this query: no page header')
  await expect(internals.getByTestId('internals-vm')).toHaveText(/^visibility map: all-visible 1 · all-frozen [01]$/)
})
