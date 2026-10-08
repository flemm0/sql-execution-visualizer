import { expect, test } from '@playwright/test'

test('Postgres starts in the browser with the seeded store database', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByTestId('pg-version')).toContainText('PostgreSQL 18', { timeout: 60_000 })
  await expect(page.getByTestId('table-order_items')).toContainText('order_items_pkey')
  await expect(page.getByTestId('table-order_items')).toContainText('3 levels')
  await expect(page.getByTestId('seed-outdated')).toHaveCount(0)
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
