import { expect, test, type Page } from '@playwright/test'
import { openApp, runSql } from './editor'

function planTree(page: Page) {
  return page.getByTestId('plan-tree')
}

function viz(page: Page) {
  return page.getByTestId('visualization')
}

/** A marked term, by the glossary term it stands for. */
function term(scope: ReturnType<Page['getByTestId']>, name: string) {
  return scope.locator(`[data-term="${name}"]`)
}

/** The definition on show; hidden ones aren't in the accessibility tree, so they don't count. */
function tooltip(page: Page) {
  return page.getByRole('tooltip')
}

test('terms are marked in the plan pane and the visualization for example 1', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders WHERE id = 4242;')
  await expect(page.getByTestId('viz-step')).toHaveText('step 11 / 11')

  // The plan: the node type, its condition, the estimate, and the buffer counts.
  await expect(term(planTree(page), 'Index Scan')).toHaveText('Index Scan')
  await expect(term(planTree(page), 'Index Cond')).toHaveText('Index Cond')
  await expect(term(planTree(page), 'estimated rows').first()).toHaveText('est.')
  await expect(term(planTree(page), 'buffer read').first()).toHaveText('read')
  // The heading still reads as Postgres prints it.
  await expect(page.getByTestId('plan-node').first()).toContainText('Index Scan using orders_pkey on orders')

  // The visualization: the node line, the zones, the search down the B-tree.
  await expect(term(viz(page), 'Index Scan')).toHaveText('Index Scan')
  await expect(term(viz(page), 'shared buffers')).toHaveText('Shared buffers')
  await expect(term(viz(page), 'heap')).toHaveText('Heap')
  await expect(term(viz(page), 'index search')).toHaveText('search')
  await expect(term(viz(page), 'leaf')).toHaveText('leaf')
  await expect(viz(page).getByTestId('viz-reads')).toHaveText('reads 3')
})

test('hovering a term shows its definition, and moving away hides it', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders WHERE id = 4242;')
  const indexCond = term(planTree(page), 'Index Cond')
  await expect(tooltip(page)).toHaveCount(0)

  await indexCond.hover()
  await expect(tooltip(page)).toHaveText(/^Index Cond: The conditions the index answers itself/)
  // The definition sits next to the term, inside the window.
  const at = await indexCond.boundingBox()
  const box = await tooltip(page).boundingBox()
  expect(box && at && Math.abs(box.y - (at.y + at.height)) < 20).toBe(true)

  await page.mouse.move(0, 0)
  await expect(tooltip(page)).toHaveCount(0)
})

test('a term reached with the keyboard shows its definition, which is also its description; Escape hides it', async ({ page }) => {
  await openApp(page)
  await runSql(page, 'SELECT * FROM orders WHERE id = 4242;')
  const nodeType = term(planTree(page), 'Index Scan')
  const estimate = term(planTree(page), 'estimated rows').first()
  await expect(estimate).toHaveAccessibleDescription(/^estimated rows: The planner’s guess/)

  await nodeType.focus()
  await expect(tooltip(page)).toHaveText(/^Index Scan: Searches a B-tree index/)
  // Tab moves to the next term: its definition replaces the last one.
  await page.keyboard.press('Tab')
  await expect(estimate).toBeFocused()
  await expect(tooltip(page)).toHaveCount(1)
  await expect(tooltip(page)).toHaveText(/^estimated rows: /)

  await page.keyboard.press('Escape')
  await expect(tooltip(page)).toHaveCount(0)
  await expect(estimate).toBeFocused()
})

test('a term in a checkbox’s label explains the word without toggling the checkbox', async ({ page }) => {
  await openApp(page)
  const checkbox = page.getByRole('checkbox', { name: 'Empty cache' })
  await expect(checkbox).toBeChecked()
  const cache = page.locator('[data-term="shared buffers"]', { hasText: 'cache' })
  await cache.click()
  await expect(tooltip(page)).toHaveText(/^shared buffers: Postgres’s cache of pages in memory/)
  await expect(checkbox).toBeChecked()
})
