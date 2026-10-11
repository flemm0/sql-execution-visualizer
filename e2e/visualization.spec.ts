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

  await control(page, 'Step forward').click()
  await expect(caption(page)).toHaveText('Seq Scan on order_items starts.')
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
  // No index: just shared buffers and the heap.
  await expect(viz(page).getByTestId('viz-index')).toHaveCount(0)
  await expect(viz(page).getByTestId('viz-minimap')).toBeVisible()
  await expect(viz(page).getByTestId('viz-minimap').locator('[data-mark]')).not.toHaveCount(0)
  // The step before the end: the last page, which has none of the rows.
  await control(page, 'Step back').click()
  await expect(caption(page)).toHaveText(/^Heap page 1,277: \d+ rows visible to the query/)
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

test('a query that can’t be animated says why, and a mismatch is flagged over the animation', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT count(*) FROM categories;')
  await expect(page.getByTestId('visualization-pane')).toContainText('Animation isn’t available yet for Aggregate.')
  await expect(viz(page)).toHaveCount(0)

  await runSql(page, 'SELECT * FROM products WHERE random() < 0.5;')
  await expect(page.getByTestId('viz-mismatch')).toBeVisible()
  await expect(viz(page).getByTestId('player')).toBeVisible()
})
