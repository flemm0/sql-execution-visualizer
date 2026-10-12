import { expect, test, type Page } from '@playwright/test'
import { openApp, runSql } from './editor'
import { clickTreePath } from './schemaTree'

function browser(page: Page) {
  return page.getByTestId('page-browser')
}

function title(page: Page) {
  return page.getByTestId('page-title')
}

function summary(page: Page) {
  return page.getByTestId('page-summary')
}

function rows(page: Page) {
  return browser(page).getByTestId('page-row')
}

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('clicking a table opens its first heap page; the arrows, page number and mini-map move through the rest', async ({ page }) => {
  await clickTreePath(page, ['orders'])
  await expect(title(page)).toHaveText('Table orders')
  await expect(summary(page)).toContainText('heap page 0 ·')
  await expect(rows(page).first()).toContainText('(0,1)')
  // The first order the seed wrote, as Postgres prints it.
  await expect(rows(page).first().locator('td').nth(1)).toHaveText('1')

  await browser(page).getByRole('button', { name: 'Next page' }).click()
  await expect(summary(page)).toContainText('heap page 1 ·')
  await expect(rows(page).first()).toContainText('(1,1)')

  const number = browser(page).getByLabel('Page number')
  await number.fill('7')
  await number.press('Enter')
  await expect(summary(page)).toContainText('heap page 7 ·')
  await expect(browser(page).getByRole('button', { name: 'Previous page' })).toBeEnabled()

  await page.getByTestId('page-minimap').locator('span').nth(2).click()
  await expect(summary(page)).toContainText('heap page 2 ·')
  await expect(page.getByTestId('page-minimap').locator('[data-current]')).toHaveAttribute('title', 'heap page 2')
})

test('clicking an index opens its root; downlinks lead to a leaf, and an entry to its heap row', async ({ page }) => {
  await clickTreePath(page, ['orders', 'Indexes', 'orders_pkey'])
  await expect(title(page)).toHaveText('Index orders_pkey')
  await expect(summary(page)).toContainText('· root ·')
  const root = await summary(page).textContent()

  // Down the leftmost downlinks to the first leaf.
  const items = browser(page).getByTestId('index-item')
  while (!((await summary(page).textContent()) ?? '').includes('· leaf ·')) {
    const before = await summary(page).textContent()
    await items.first().getByRole('button').click()
    await expect(summary(page)).not.toHaveText(before ?? '')
  }
  await expect(items.first().getByTestId('index-key')).toHaveText('1')
  await expect(items.first().getByRole('button')).toHaveText('→ (0,1)')
  await expect(browser(page).getByRole('button', { name: 'Page to the left' })).toBeDisabled()

  // Back goes up the way it came (orders_pkey has 2 levels); Root jumps to the top.
  await browser(page).getByRole('button', { name: 'Back', exact: true }).click()
  await expect(summary(page)).toHaveText(root ?? '')
  await expect(browser(page).getByRole('button', { name: 'Back', exact: true })).toBeDisabled()
  await expect(browser(page).getByRole('button', { name: 'Root' })).toBeDisabled()

  // Down again, and across to the heap row the first entry points at.
  while (!((await summary(page).textContent()) ?? '').includes('· leaf ·')) {
    const before = await summary(page).textContent()
    await items.first().getByRole('button').click()
    await expect(summary(page)).not.toHaveText(before ?? '')
  }
  await browser(page).getByRole('button', { name: 'Root' }).click()
  await expect(summary(page)).toHaveText(root ?? '')
  while (!((await summary(page).textContent()) ?? '').includes('· leaf ·')) {
    const before = await summary(page).textContent()
    await items.first().getByRole('button').click()
    await expect(summary(page)).not.toHaveText(before ?? '')
  }
  await items.first().getByRole('button', { name: '→ (0,1)' }).click()
  await expect(title(page)).toHaveText('Table orders')
  await expect(rows(page).first()).toHaveAttribute('data-highlighted', '')
  await expect(rows(page).first()).toContainText('(0,1)')

  // Clicking the index again opens its root once more.
  await clickTreePath(page, ['orders', 'Indexes', 'orders_pkey'])
  await expect(summary(page)).toHaveText(root ?? '')
})

test('a run reads the open page again, so it shows what the statement changed', async ({ page }) => {
  await runSql(page, `CREATE TABLE notes (id int, note text); INSERT INTO notes VALUES (1, 'first'), (2, NULL);`)
  await clickTreePath(page, ['notes'])
  await expect(title(page)).toHaveText('Table notes')
  await expect(rows(page)).toHaveCount(2)
  await expect(rows(page).nth(1)).toContainText('NULL')

  await runSql(page, `UPDATE notes SET note = 'changed' WHERE id = 1;`)
  // The old version stays on the page, out of sight; the new one goes at the end.
  await expect(rows(page)).toHaveCount(3)
  await expect(rows(page).nth(0)).toHaveAttribute('data-state', 'normal')
  await expect(rows(page).nth(0)).toContainText('not visible to this session')
  await expect(rows(page).nth(2)).toContainText('changed')
})

test('a query to animate takes the pane back; Back to the animation returns to where it paused', async ({ page }) => {
  await clickTreePath(page, ['categories'])
  await expect(title(page)).toHaveText('Table categories')
  // No animation yet, so nothing to go back to.
  await expect(browser(page).getByRole('button', { name: 'Back to the animation' })).toHaveCount(0)

  await runSql(page, 'SELECT * FROM categories WHERE id = 3;')
  await expect(page.getByTestId('visualization')).toBeVisible()
  await page.getByTestId('player').getByRole('button', { name: 'To the end' }).click()
  const step = await page.getByTestId('viz-step').textContent()

  await clickTreePath(page, ['categories'])
  await expect(browser(page)).toBeVisible()
  await browser(page).getByRole('button', { name: 'Back to the animation' }).click()
  await expect(page.getByTestId('viz-step')).toHaveText(step ?? '')

  // A statement with nothing to animate leaves an open page where it is.
  await clickTreePath(page, ['categories'])
  await runSql(page, 'SELECT count(*) FROM categories;')
  await expect(page.getByTestId('run-status')).toContainText('SELECT: 1 row')
  await expect(browser(page)).toBeVisible()
})

test('an index that can’t be browsed says why', async ({ page }) => {
  await runSql(page, 'CREATE INDEX categories_name_hash ON categories USING hash (name);')
  await clickTreePath(page, ['categories', 'Indexes', 'categories_name_hash'])
  await expect(page.getByTestId('page-error')).toHaveText(
    'Only B-tree indexes can be browsed so far; categories_name_hash is a hash index.',
  )
})
