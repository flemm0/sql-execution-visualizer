import { expect, test } from '@playwright/test'

test('Postgres starts in the browser with the seeded store database', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByTestId('pg-version')).toContainText('PostgreSQL 18', { timeout: 60_000 })
  await expect(page.getByTestId('table-order_items')).toContainText('order_items_pkey')
  await expect(page.getByTestId('table-order_items')).toContainText('3 levels')
  // The same page count as the Node tests: the browser builds an identical database.
  await expect(page.getByTestId('table-order_items')).toContainText('1,278 heap pages')
  await expect(page.getByTestId('seed-outdated')).toHaveCount(0)
})

test('two tabs opened at once share one database, seeded once', async ({ context }) => {
  const [first, second] = await Promise.all([context.newPage(), context.newPage()])
  await Promise.all([first.goto('./'), second.goto('./')])
  const seededAt = await first.getByTestId('seeded-at').textContent({ timeout: 60_000 })
  await expect(second.getByTestId('seeded-at')).toHaveText(seededAt ?? '', { timeout: 60_000 })
})

test('the database is saved in the browser and loaded on reload, not regenerated', async ({ page }) => {
  await page.goto('./')
  const seededAt = await page.getByTestId('seeded-at').textContent({ timeout: 60_000 })
  await page.reload()
  await expect(page.getByTestId('seeded-at')).toHaveText(seededAt ?? '', { timeout: 60_000 })
})

test('Reset database regenerates the sample data', async ({ page }) => {
  await page.goto('./')
  const seededAt = await page.getByTestId('seeded-at').textContent({ timeout: 60_000 })
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Reset database' }).click()
  await expect(page.getByTestId('seeded-at')).not.toHaveText(seededAt ?? '', { timeout: 60_000 })
  await expect(page.getByTestId('table-order_items')).toContainText('3 levels')
})
