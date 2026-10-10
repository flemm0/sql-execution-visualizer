import { expect, test, type Page } from '@playwright/test'
import { openApp, runSql } from './editor'

function replayStatus(page: Page) {
  return page.getByTestId('replay-status')
}

/** A check's row: its label, Postgres's number and the replay's, e.g. "✓ Result: rows 189 189". */
function check(page: Page, label: string) {
  return page.locator(`[data-testid="replay-check"][data-check="${label}"]`)
}

test('example 2 replays and matches what Postgres reported, check by check', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM order_items WHERE product_id = 42;')
  await expect(replayStatus(page)).toContainText('✓ Replay matches Postgres · 6 checks')
  // The checks are folded away when everything matches.
  await expect(check(page, 'Result: rows')).toBeHidden()
  await replayStatus(page).getByText('Replay matches Postgres').click()
  await expect(check(page, 'Seq Scan on order_items: buffer reads')).toHaveText(
    '✓ Seq Scan on order_items: buffer reads1,2781,278',
  )
  await expect(check(page, 'Result: rows')).toHaveText('✓ Result: rows189189')
})

test('a query with a node the replay engine doesn’t know yet says so', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders WHERE id = 4242;')
  await expect(replayStatus(page)).toHaveText('Animation isn’t available yet for Index Scan.')
})

test('a mismatch is shown with the checks that failed', async ({ page }) => {
  await openApp(page)
  // random() gives other rows each time the query runs: once for EXPLAIN ANALYZE,
  // once for the result, and once for the replay's own question to Postgres.
  await runSql(page, 'SELECT * FROM products WHERE random() < 0.5;')
  await expect(replayStatus(page)).toContainText('✗ Replay doesn’t match Postgres')
  await expect(check(page, 'Result: rows with the same values, in the same order')).toContainText('✗')
})
