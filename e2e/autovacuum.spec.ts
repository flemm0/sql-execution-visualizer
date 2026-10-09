import { expect, test, type Page } from '@playwright/test'
import { openApp, runSql, statusLines, waitForRunToFinish } from './editor'
import { clickTreePath, fact } from './schemaTree'

function toasts(page: Page) {
  return page.getByTestId('autovacuum-toast')
}

function autovacuumSetting(page: Page) {
  return page.getByRole('checkbox', { name: 'Autovacuum' })
}

test('analyzes a table once enough rows changed, says why, and shows the reset counters', async ({ page }) => {
  await openApp(page)
  // orders has 50,000 rows: autovacuum analyzes it after more than 50 + 10% = 5,050 changed rows.
  await runSql(page, `UPDATE orders SET status = 'shipped' WHERE id <= 5050;`)
  await expect(statusLines(page)).toHaveText(/UPDATE: 5,050 rows/)
  await clickTreePath(page, ['orders'])
  await expect(fact(page, 'Changed since analyze')).toHaveText('5,050 rows; analyzes above 5,050')
  await waitForRunToFinish(page)
  await expect(toasts(page)).toHaveCount(0)

  await runSql(page, `UPDATE orders SET status = 'shipped' WHERE id = 5051;`)
  await expect(toasts(page)).toHaveCount(1)
  await expect(toasts(page)).toContainText('autovacuum: analyzed orders')
  await expect(toasts(page)).toContainText('5,051 rows changed since the last analyze (threshold 5,050)')
  await expect(fact(page, 'Changed since analyze')).toHaveText('0 rows; analyzes above 5,050')
  await expect(fact(page, 'Dead rows')).toHaveText(/^5,051 rows; vacuums above 10,050$/)
  await expect(fact(page, 'Last analyze')).not.toHaveText('not since this page loaded')

  await toasts(page).getByRole('button', { name: 'Dismiss' }).click()
  await expect(toasts(page)).toHaveCount(0)
})

test('waits for an open transaction to end', async ({ page }) => {
  await openApp(page)
  // customers has 10,000 rows: analyzed above 1,050 changed rows, vacuumed above 2,050 dead ones.
  // Changes made while the simulator is off still count, so these 1,100 are due an ANALYZE...
  await autovacuumSetting(page).uncheck()
  await runSql(page, 'UPDATE customers SET city = city WHERE id <= 1100;')
  await waitForRunToFinish(page)
  await autovacuumSetting(page).check()

  // ...but not inside the visitor's transaction, where a ROLLBACK would undo it.
  await runSql(page, `BEGIN;\nUPDATE customers SET city = city WHERE id <= 10;`)
  await expect(statusLines(page)).toHaveCount(2)
  await waitForRunToFinish(page)
  await expect(toasts(page)).toHaveCount(0)

  await runSql(page, 'COMMIT;')
  await expect(toasts(page)).toContainText('autovacuum: analyzed customers')
  await expect(toasts(page)).toContainText('1,110 rows changed since the last analyze (threshold 1,050)')
})

test('can be turned off, and stays off after a reload', async ({ page }) => {
  await openApp(page)
  await autovacuumSetting(page).uncheck()
  await runSql(page, 'UPDATE products SET price = price;')
  await expect(statusLines(page)).toHaveText(/UPDATE: 1,000 rows/)
  await clickTreePath(page, ['products'])
  await expect(fact(page, 'Status')).toHaveText('off (simulator turned off)')
  await expect(fact(page, 'Changed since analyze')).toHaveText('1,000 rows; analyzes above 150')
  await waitForRunToFinish(page)
  await expect(toasts(page)).toHaveCount(0)

  await page.reload()
  await openApp(page)
  await expect(autovacuumSetting(page)).not.toBeChecked()

  // Postgres restarted with the page, so its counters started from zero again,
  // as on a real server after a crash: the changes made before the reload are forgotten.
  await autovacuumSetting(page).check()
  await clickTreePath(page, ['products'])
  await expect(fact(page, 'Status')).toHaveText('on')
  await expect(fact(page, 'Changed since analyze')).toHaveText('0 rows; analyzes above 150')
})
