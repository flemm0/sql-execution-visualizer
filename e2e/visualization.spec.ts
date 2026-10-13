import { expect, test, type Page } from '@playwright/test'
import { openApp, runSql } from './editor'

function viz(page: Page) {
  return page.getByTestId('visualization')
}

function step(page: Page) {
  return page.getByTestId('viz-step')
}

function caption(page: Page) {
  return page.getByTestId('viz-caption')
}

function control(page: Page, name: string) {
  return page.getByTestId('player').getByRole('button', { name, exact: true })
}

test('example 1 plays by itself, down the index to one row', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders WHERE id = 4242;')
  // 11 steps at the default 30 steps a second: it finishes in well under a second.
  await expect(step(page)).toHaveText('step 11 / 11')
  await expect(caption(page)).toHaveText(
    'Index Scan using orders_pkey on orders has no more rows: it sent 1 row to the result.',
  )
  await expect(control(page, 'Play')).toBeVisible()
  await expect(viz(page).getByTestId('viz-rows')).toHaveText('rows: 1 so far / est. 1')
  await expect(viz(page).getByTestId('viz-reads')).toHaveText('reads 3')
  await expect(viz(page).getByTestId('viz-hits')).toHaveText('hits 0')
  // The B-tree, drawn as a textbook draws one: the root, its followed pointer down to the leaf, then the leaf.
  const pages = viz(page).getByTestId('viz-btree-page')
  await expect(pages).toHaveCount(2)
  await expect(pages.first()).toContainText(/^idx p\d+ · root/)
  const leafBlock = await pages.last().getAttribute('data-block')
  const followed = pages.first().locator('[data-mark="followed"]')
  await expect(followed).toHaveCount(1)
  await expect(followed).toHaveAttribute('data-kind', 'gap')
  await expect(followed).toContainText(`→ idx p${leafBlock}`)
  await expect(viz(page).locator('[data-testid="viz-btree-link"][data-kind="down"]')).toHaveCount(1)
  // The root's other children, left and right of the one followed, as counted boxes.
  await expect(viz(page).getByTestId('viz-btree-ghost')).toHaveText([/^\d+ pages$/, /^\d+ pages$/])
  await expect(pages.last()).toContainText(/^idx p\d+ · leaf/)
  // The entry that matched, and the heap row it points at.
  const matched = pages.last().locator('[data-mark="matched"]')
  await expect(matched).toHaveCount(1)
  await expect(matched).toHaveText('4242')
  await expect(viz(page).getByTestId('viz-btree-row')).toHaveText(/^heap row \(\d+,\d+\)$/)
  await expect(viz(page).getByTestId('viz-heap-row')).toHaveAttribute('data-outcome', 'emitted')
  await expect(viz(page).getByTestId('viz-heap-row')).toContainText('→ result row 1')
})

test('example 2 runs through every page of order_items, step by step or straight to the end', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM order_items WHERE product_id = 42;')
  await expect(viz(page)).toBeVisible()
  await control(page, 'Pause').click()
  await control(page, 'To the start').click()
  await expect(step(page)).toHaveText(/^step 0 \/ /)
  await expect(caption(page)).toContainText('Ready to replay')
  // The plan tree follows the player: the Seq Scan waits, then works, counting its rows as it goes.
  const planNode = page.getByTestId('plan-node')
  await expect(planNode).toHaveAttribute('data-status', 'waiting')
  await expect(planNode.getByTestId('plan-status')).toHaveText('waiting')
  await expect(planNode.getByTestId('plan-rows')).toHaveText(/^rows 0 so far of 189 · est\. \d+$/)

  await control(page, 'Step forward').click()
  await expect(caption(page)).toHaveText('Seq Scan on order_items starts.')
  await expect(planNode).toHaveAttribute('aria-current', 'step')
  await expect(planNode.getByTestId('plan-status')).toHaveText('◀ active')
  await control(page, 'Step forward').click()
  await expect(caption(page)).toHaveText('Heap page 0 isn’t in shared buffers, so it’s read from disk into a buffer.')
  await expect(viz(page).getByTestId('viz-slot')).toHaveAttribute('data-current', 'buffer.read')
  await control(page, 'Step forward').click()
  await expect(caption(page)).toContainText(/^Heap page 0: \d+ rows visible to the query, checked against the filter/)
  await control(page, 'Step back').click()
  await expect(step(page)).toHaveText(/^step 2 \//)

  await control(page, 'To the end').click()
  await expect(caption(page)).toHaveText('Seq Scan on order_items has no more rows: it sent 189 rows to the result.')
  await expect(viz(page).getByTestId('viz-reads')).toHaveText('reads 1,278')
  await expect(viz(page).getByTestId('viz-rows')).toContainText('rows: 189 so far')
  // At the end the plan shows Postgres's totals alone, with no node highlighted.
  await expect(planNode).not.toHaveAttribute('aria-current', 'step')
  await expect(planNode.getByTestId('plan-status')).toHaveCount(0)
  await expect(planNode.getByTestId('plan-rows')).toHaveText(/^rows 189 · est\. \d+$/)
  // No index: just shared buffers and the heap.
  await expect(viz(page).getByTestId('viz-index')).toHaveCount(0)
  await expect(viz(page).getByTestId('viz-minimap')).toBeVisible()
  await expect(viz(page).getByTestId('viz-minimap').locator('[data-mark]')).not.toHaveCount(0)
  // The step before the end: the last page, which has none of the rows.
  await control(page, 'Step back').click()
  await expect(caption(page)).toHaveText(/^Heap page 1,277: \d+ rows visible to the query/)
  await expect(planNode.getByTestId('plan-rows')).toHaveText(/^rows 189 so far of 189 · est\. \d+$/)
  await expect(planNode.getByTestId('plan-status')).toHaveText('◀ active')
})

test('example 4 walks right along the leaves; the timeline moves to any step', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000;')
  await expect(viz(page)).toBeVisible()
  await control(page, 'To the end').click()
  await expect(viz(page).getByTestId('viz-reads')).toHaveText('reads 18')
  await expect(viz(page).getByTestId('viz-rows')).toContainText('rows: 1,001 so far')
  // The root, then the 4 leaves walked left to right: the first and third small, a count for the second, the last in full.
  const pages = viz(page).getByTestId('viz-btree-page')
  await expect(pages).toHaveCount(4)
  await expect(viz(page).locator('[data-testid="viz-btree-page"][data-compact]')).toHaveCount(2)
  await expect(viz(page).getByTestId('viz-btree-ghost')).toContainText(['+1'])
  await expect(viz(page).locator('[data-testid="viz-btree-link"][data-kind="right"]')).toHaveCount(3)
  await expect(pages.last().locator('[data-mark="matched"]')).not.toHaveCount(0)

  await page.getByRole('slider', { name: 'Timeline' }).fill('6')
  await expect(step(page)).toHaveText(/^step 6 \//)
  await expect(viz(page).getByTestId('viz-rows')).toContainText('rows: 0 so far')
  // Step 6 visits the first leaf: the search has gone down from the root, but nothing matched yet.
  await expect(pages).toHaveCount(2)
  await expect(pages.last()).toHaveAttribute('data-current', '')
  await expect(pages.last().locator('[data-mark="matched"]')).toHaveCount(0)
})

test('the result fills in as the animation emits rows, and Skip to end shows it whole', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM order_items WHERE product_id = 42;')
  const filling = page.getByTestId('rows-filling')
  const tableRows = page.getByTestId('result-table').locator('tbody tr')
  await control(page, 'Pause').click()
  await control(page, 'To the start').click()
  await expect(filling).toHaveText('Rows appear as the animation sends them to the result: 0 of 189 so far.Skip to end')
  await expect(tableRows).toHaveCount(0)

  // Halfway through, the table holds exactly the rows the visualization has sent, the latest highlighted.
  const steps = Number((await step(page).textContent())?.match(/\/ ([\d,]+)/)?.[1].replace(/,/g, ''))
  await page.getByRole('slider', { name: 'Timeline' }).fill(String(Math.floor(steps / 2)))
  const sent = Number((await viz(page).getByTestId('viz-rows').textContent())?.match(/rows: (\d+) so far/)?.[1])
  expect(sent).toBeGreaterThan(0)
  expect(sent).toBeLessThan(189)
  await expect(filling).toContainText(`${sent} of 189 so far`)
  await expect(tableRows).toHaveCount(sent)
  await expect(tableRows.last()).toHaveAttribute('data-latest', '')
  await expect(page.locator('[data-latest]')).toHaveCount(1)

  await page.getByRole('button', { name: 'Skip to end' }).click()
  await expect(step(page)).toHaveText(`step ${steps.toLocaleString('en-US')} / ${steps.toLocaleString('en-US')}`)
  await expect(filling).toHaveCount(0)
  await expect(tableRows).toHaveCount(189)
  await expect(page.locator('[data-latest]')).toHaveCount(0)
})

test('a query that can’t be animated shows its whole result at once', async ({ page }) => {
  await openApp(page)
  // Append isn't replayed yet.
  await runSql(page, 'SELECT name FROM categories UNION ALL SELECT name FROM categories;')
  await expect(page.getByTestId('replay-status')).toHaveText('Animation isn’t available yet for Append.')
  await expect(page.getByTestId('result-table').locator('tbody tr')).toHaveCount(24)
  await expect(page.getByTestId('rows-filling')).toHaveCount(0)
})

test('example 11 plays the one page of categories', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM categories WHERE id = 3;')
  await expect(caption(page)).toHaveText('Seq Scan on categories has no more rows: it sent 1 row to the result.')
  await expect(viz(page).getByTestId('viz-heap-page')).toContainText('heap page 0')
  await expect(viz(page).getByTestId('viz-heap-row')).toContainText('→ result row 1')
})

test('with a warm cache the pages are hits; the speed is remembered', async ({ page }) => {
  await openApp(page)
  await page.getByRole('checkbox', { name: 'Empty cache' }).uncheck()
  await runSql(page, 'SELECT * FROM orders WHERE id = 4242;')
  await page.getByLabel('Speed').selectOption('instant')
  await runSql(page, 'SELECT * FROM orders WHERE id = 4242;')
  await expect(step(page)).toHaveText('step 11 / 11')
  await expect(viz(page).getByTestId('viz-hits')).toHaveText('hits 3')
  await expect(viz(page).getByTestId('viz-reads')).toHaveText('reads 0')

  await page.reload()
  await openApp(page)
  await runSql(page, 'SELECT * FROM order_items WHERE product_id = 42;')
  // Instant: straight to the end of 2,700-odd steps.
  await expect(caption(page)).toHaveText('Seq Scan on order_items has no more rows: it sent 189 rows to the result.')
  await expect(page.getByLabel('Speed')).toHaveValue('instant')
})

test('with autoplay off, a run waits paused at step 0, and the choice is remembered', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders WHERE id = 4242;')
  await expect(control(page, 'Pause').or(control(page, 'Play'))).toBeVisible()
  await page.getByRole('checkbox', { name: 'Autoplay' }).uncheck()

  await page.reload()
  await openApp(page)
  // Even at instant speed, which would otherwise jump straight to the end.
  await runSql(page, 'SELECT * FROM orders WHERE id = 4242;')
  await page.getByLabel('Speed').selectOption('instant')
  await runSql(page, 'SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000;')
  await expect(page.getByRole('checkbox', { name: 'Autoplay' })).not.toBeChecked()
  await expect(step(page)).toHaveText(/^step 0 \/ /)
  await expect(control(page, 'Play')).toBeVisible()
  await expect(page.getByTestId('rows-filling')).toContainText('0 of 1,001 so far')

  await control(page, 'Play').click()
  await expect(page.getByTestId('rows-filling')).toHaveCount(0)
  await expect(caption(page)).toContainText('has no more rows')
})

test('a query that can’t be animated says why, and a mismatch is flagged over the animation', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT count(*) FROM categories;')
  await expect(page.getByTestId('visualization-pane')).toContainText('Animation isn’t available yet for Aggregate.')
  await expect(viz(page)).toHaveCount(0)

  await runSql(page, 'SELECT * FROM products WHERE random() < 0.5;')
  await expect(page.getByTestId('viz-mismatch')).toBeVisible()
  await expect(viz(page).getByTestId('player')).toBeVisible()
})

test('example 9: an index-only scan reads the visibility map, not the heap, until an update clears its bits', async ({ page }) => {
  await openApp(page)
  const example9 = 'SELECT order_date FROM orders WHERE customer_id = 42;'
  await runSql(page, example9)
  await control(page, 'To the end').click()
  await expect(caption(page)).toHaveText(
    'Index Only Scan using orders_customer_id_order_date_idx on orders has no more rows: it sent 3 rows to the result.',
  )
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
  // Two index pages and the visibility map's one page: no heap page.
  await expect(viz(page).getByTestId('viz-slot')).toHaveText([/^i\d+$/, /^i\d+$/, 'vm0'])
  await expect(viz(page).getByTestId('viz-all-visible')).toHaveText('· all-visible: not read, rows from the index')
  await expect(viz(page).locator('[data-testid="viz-minimap"] [data-mark="fromIndex"]')).toHaveCount(3)
  await expect(viz(page).locator('[data-testid="viz-minimap"] [data-mark="result"]')).toHaveCount(0)

  // Step back to the first entry's visibility check: its caption says why the heap isn't read.
  // The animation had finished, so going back to the start leaves it paused there.
  await control(page, 'To the start').click()
  await expect(control(page, 'Play')).toBeVisible()
  await expect(step(page)).toHaveText(/^step 0 \//)
  for (let i = 0; i < 9; i++) await control(page, 'Step forward').click()
  await expect(caption(page)).toContainText(/^The visibility map marks heap page \d+ all-visible/)

  // An update clears the bits of the pages it touches: now the rows are fetched from the heap.
  await runSql(page, 'UPDATE orders SET total = total WHERE customer_id = 42;')
  await runSql(page, example9)
  await control(page, 'To the end').click()
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
  await expect(viz(page).getByTestId('viz-all-visible')).toHaveText('· not all-visible: rows fetched')
  await expect(viz(page).locator('[data-testid="viz-minimap"] [data-mark="fromIndex"]')).toHaveCount(0)
  // The old versions' entries and the new ones': 6 rows fetched.
  await expect(page.getByTestId('plan-pane')).toContainText(/Heap Fetches\s*6/)

  // VACUUM sets them again.
  await runSql(page, 'VACUUM orders;')
  await runSql(page, example9)
  await control(page, 'To the end').click()
  await expect(viz(page).getByTestId('viz-all-visible')).toHaveText('· all-visible: not read, rows from the index')
})

test('example 6: a bitmap scan marks every matching row first, then reads each of their heap pages once, in physical order', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders WHERE customer_id BETWEEN 100 AND 300;')
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
  await control(page, 'Pause').click()
  const minimap = (mark: string) => viz(page).locator(`[data-testid="viz-minimap"] [data-mark="${mark}"]`)

  // Both nodes start, the search reads 4 index pages (an access and a visit each), then 944 entries match: step 955.
  await page.getByRole('slider', { name: 'Timeline' }).fill('955')
  await expect(caption(page)).toContainText(/^Entry .+ matches; the scan marks its row, \(\d+,\d+\), in the bitmap instead of fetching it/)
  await expect(viz(page).getByTestId('viz-node')).toContainText('Bitmap Index Scan on orders_customer_id_order_date_idx')
  await expect(viz(page).getByTestId('viz-rows')).toHaveText(/^rows: 944 so far/)
  // The bitmap so far: violet on the mini-map, and no heap page read yet.
  await expect(viz(page).getByTestId('viz-bitmap')).toHaveText('bitmap: 944 rows on 480 pages')
  await expect(minimap('bitmap')).toHaveCount(480)
  await expect(viz(page).getByTestId('viz-heap-page')).toHaveCount(0)
  await expect(viz(page).getByTestId('viz-btree-row')).toHaveAttribute('data-kind', 'bitmap')
  await expect(viz(page).getByTestId('viz-btree-row')).toHaveText(/^bitmap: row \(\d+,\d+\)$/)
  // The plan tree: the heap scan is busy waiting on its child, which counts the rows it marked.
  const planNode = page.getByTestId('plan-node')
  await expect(planNode).toHaveCount(2)
  await expect(planNode.nth(0)).toHaveAttribute('data-status', 'active')
  await expect(planNode.nth(1).getByTestId('plan-rows')).toHaveText(/^rows 944 so far of 944 · est\. \d+$/)

  await control(page, 'Step forward').click()
  await expect(caption(page)).toHaveText(
    'Bitmap Index Scan on orders_customer_id_order_date_idx is done: its bitmap marks 944 rows on 480 heap pages. Bitmap Heap Scan on orders reads those pages next, in physical order, each one once.',
  )
  await expect(planNode.nth(1)).toHaveAttribute('data-status', 'done')
  await control(page, 'Step forward').click()
  await expect(caption(page)).toHaveText(
    /^Heap page \d+, page 1 of 480 in the bitmap, has \d+ rows? marked\. It isn’t in shared buffers, so it’s read from disk into a buffer\.$/,
  )
  await expect(viz(page).getByTestId('viz-node')).toContainText('Bitmap Heap Scan on orders')
  await expect(viz(page).getByTestId('viz-bitmap-rows')).toHaveText(/· \d+ rows? marked in the bitmap$/)
  await expect(viz(page).getByTestId('viz-bitmap')).toHaveText('bitmap: 944 rows on 480 pages · 1 of 480 read')
  await expect(minimap('bitmap')).toHaveCount(479)

  await control(page, 'To the end').click()
  await expect(caption(page)).toHaveText('Bitmap Heap Scan on orders has no more rows: it sent 944 rows to the result.')
  await expect(viz(page).getByTestId('viz-bitmap')).toHaveText('bitmap: 944 rows on 480 pages · 480 of 480 read')
  await expect(minimap('bitmap')).toHaveCount(0)
  await expect(minimap('result')).toHaveCount(480)
})

test('example 10: a Limit takes the latest 3 orders from a backward index scan, then stops it', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders WHERE customer_id = 42 ORDER BY order_date DESC LIMIT 3;')
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
  await control(page, 'To the end').click()
  await expect(caption(page)).toHaveText('Limit has no more rows: it sent 3 rows to the result.')
  // The result is the latest orders first.
  const dates = await page.getByTestId('result-table').locator('tbody tr td:nth-child(3)').allTextContents()
  expect(dates).toEqual([...dates].sort().reverse())

  await control(page, 'Step back').click()
  const scan = 'Index Scan Backward using orders_customer_id_order_date_idx on orders'
  await expect(caption(page)).toHaveText(
    `Limit has passed on its 3 rows (LIMIT 3), so it stops: it doesn’t ask ${scan} for another row, which stops where it is.`,
  )
  await expect(viz(page).getByTestId('viz-limit')).toHaveText('Limit · LIMIT 3: 3 passed on · stopped: it asks for no more rows')
  // The plan tree: the Limit still works, the scan below it was stopped before it finished.
  const planNode = page.getByTestId('plan-node')
  await expect(planNode.nth(0)).toHaveAttribute('data-status', 'active')
  await expect(planNode.nth(1)).toHaveAttribute('data-status', 'stopped')
  await expect(planNode.nth(1).getByTestId('plan-status')).toHaveText('stopped early')

  // The search runs backward: for the last entry that can match.
  await control(page, 'To the start').click()
  for (let i = 0; i < 3; i++) await control(page, 'Step forward').click()
  await expect(caption(page)).toHaveText(
    'The scan reads orders_customer_id_order_date_idx backward, from high keys to low: it searches from the root for the last entry that can match.',
  )
})

test('example 10: a Sort holds every matching order, sorts them by total, then passes them on in order', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders WHERE customer_id = 42 ORDER BY total DESC LIMIT 10;')
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
  await control(page, 'Pause').click()
  const timeline = page.getByRole('slider', { name: 'Timeline' })
  const sort = viz(page).getByTestId('viz-sort')

  // Step 23: the bitmap heap scan has passed its 3 rows up to the Sort, which holds them.
  await timeline.fill('23')
  await expect(caption(page)).toHaveText('Bitmap Heap Scan on orders has no more rows: it passed 3 rows up to Sort.')
  await expect(sort.getByTestId('viz-sort-summary')).toHaveText('in memory: 3 rows')
  await expect(sort.getByTestId('viz-sort-row')).toHaveCount(3)
  await expect(page.getByTestId('rows-filling')).toContainText('0 of 3 so far')

  await control(page, 'Step forward').click()
  await expect(caption(page)).toHaveText(
    'Sort has all 3 rows from below: it sorts them in memory by orders.total DESC (a quicksort), then passes them up to Limit in that order.',
  )
  await expect(sort.getByTestId('viz-sort-summary')).toHaveText('sorted 3 rows (quicksort) · 0 of 3 passed on')
  await control(page, 'Step forward').click()
  await expect(caption(page)).toHaveText(/^Row \(\d+,\d+\), 1st in sort order, goes up to Limit\.$/)
  await control(page, 'Step forward').click()
  await expect(caption(page)).toHaveText(/^Row \(\d+,\d+\) goes to the result as row 1 \(1 of the Limit’s 10\)\.$/)
  await expect(page.getByTestId('rows-filling')).toContainText('1 of 3 so far')

  await control(page, 'To the end').click()
  await expect(sort.getByTestId('viz-sort-summary')).toHaveText('sorted 3 rows (quicksort) · 3 of 3 passed on')
  const totals = await page.getByTestId('result-table').locator('tbody tr td:nth-child(5)').allTextContents()
  expect(totals.map(Number)).toEqual([...totals.map(Number)].sort((a, b) => b - a))
})

test('a top-N heapsort keeps the best 10 of 50,000 orders as the Seq Scan passes them up', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders ORDER BY total DESC LIMIT 10;')
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres', { timeout: 30_000 })
  await control(page, 'Pause').click()
  await page.getByRole('slider', { name: 'Timeline' }).fill('30001')
  const sort = viz(page).getByTestId('viz-sort')
  await expect(sort.getByTestId('viz-sort-summary')).toHaveText('top-N heapsort: keeps the best 10 · 14,833 seen · 14,823 dropped')
  // The best 5 kept, then the worst: the one a new row has to beat.
  await expect(sort.getByTestId('viz-sort-row')).toHaveCount(6)
  await expect(sort.getByTestId('viz-sort-row').last()).toContainText('← worst kept')
  await expect(caption(page)).toHaveText(/^Row \(175,1\) \(total [\d.]+\) doesn’t sort before the worst row kept, .+, so it’s dropped\.$/)
  // While the scan gives it rows, the Sort works too.
  await expect(viz(page).getByTestId('viz-node')).toContainText('Sort')
  await expect(viz(page).getByTestId('viz-node')).toContainText('active')

  await control(page, 'To the end').click()
  await expect(sort.getByTestId('viz-sort-summary')).toHaveText('sorted 10 rows (top-N heapsort) · 10 of 10 passed on')
})

test('a Limit stops a Seq Scan part way, after it has read pages ahead it won’t use', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM order_items LIMIT 500;')
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
  await control(page, 'To the end').click()
  await expect(caption(page)).toHaveText('Limit has no more rows: it sent 500 rows to the result.')
  // Pages 0 to 6 read: 4, 5 and 6 ahead of the scan, which stopped on page 3.
  await expect(viz(page).getByTestId('viz-reads')).toHaveText('reads 7')
  await expect(viz(page).locator('[data-testid="viz-slot"][data-ahead]')).toHaveText(['h4', 'h5', 'h6'])
  await expect(viz(page).getByTestId('viz-heap-counts')).toHaveText(/· \d+ visible · \d+ checked before the stop · \d+ matched$/)
  await control(page, 'Step back').click()
  await expect(caption(page)).toHaveText(
    'Heap page 6 had been read from disk into a buffer ahead of the scan, but the scan stopped before it got there. Postgres reads the pages a scan will need next in batches, and counts them all.',
  )
  await expect(page.getByTestId('plan-node').nth(1).getByTestId('plan-status')).toHaveText('stopped early')
})
