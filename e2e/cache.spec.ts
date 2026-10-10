import { expect, test, type Page } from '@playwright/test'
import { openApp, runSql, waitForRunToFinish } from './editor'

const EXAMPLE_1 = 'SELECT * FROM orders WHERE id = 4242;'

function emptyCacheSetting(page: Page) {
  return page.getByRole('checkbox', { name: 'Empty cache' })
}

/** The buffer counts of the plan's top node, which include its children's. */
function rootBuffers(page: Page) {
  return page.getByTestId('plan-buffers').first()
}

test('starts each query with an empty cache; turned off, a rerun finds its pages cached', async ({ page }) => {
  await openApp(page)
  await expect(emptyCacheSetting(page)).toBeChecked()

  // The B-tree root, one leaf and one heap page, all read from disk.
  await runSql(page, EXAMPLE_1)
  await expect(rootBuffers(page)).toHaveText('buffers: hit 0 · read 3')

  await waitForRunToFinish(page)
  await emptyCacheSetting(page).uncheck()
  await runSql(page, EXAMPLE_1)
  await expect(rootBuffers(page)).toHaveText('buffers: hit 3 · read 0')

  await waitForRunToFinish(page)
  await emptyCacheSetting(page).check()
  await runSql(page, EXAMPLE_1)
  await expect(rootBuffers(page)).toHaveText('buffers: hit 0 · read 3')
})

test('remembers the empty-cache setting after a reload', async ({ page }) => {
  await openApp(page)
  await emptyCacheSetting(page).uncheck()
  await page.reload()
  await openApp(page)
  await expect(emptyCacheSetting(page)).not.toBeChecked()
})

test('shows the pages planning found cached or read, apart from the plan’s nodes', async ({ page }) => {
  await openApp(page)
  await runSql(page, EXAMPLE_1)
  await expect(page.getByTestId('plan-planning')).toHaveText(/^Planning [\d.]+ ms · buffers: hit \d+ · read \d+$/)
  await expect(page.getByTestId('plan-tree')).toContainText(/Execution [\d.]+ ms/)
})
