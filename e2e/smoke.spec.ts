import { expect, test } from '@playwright/test'

test('Postgres starts in the browser and reads real pages', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByTestId('pg-version')).toContainText('PostgreSQL 18', { timeout: 60_000 })
  await expect(page.getByTestId('btree-root')).toContainText('levels')
  await expect(page.getByTestId('lookup')).toContainText('Index Scan')
})
