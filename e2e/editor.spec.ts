import { expect, test } from '@playwright/test'
import { editorContent, openApp, planNodes, runSql, setEditorText, statusLines } from './editor'
import { clickTreePath, treeItem } from './schemaTree'

test.beforeEach(async ({ page }) => {
  await openApp(page)
})

test('Cmd/Ctrl+Enter runs the statement under the cursor and shows its rows and plan', async ({ page }) => {
  await setEditorText(page, 'SELECT id, status FROM orders WHERE id = 4242;\nSELECT 2;')
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.press('ControlOrMeta+Enter')

  await expect(statusLines(page)).toHaveCount(1)
  await expect(statusLines(page)).toContainText('SELECT: 1 row')
  const table = page.getByTestId('result-table')
  await expect(table.locator('th')).toHaveText(['id', 'status'])
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table.locator('tbody td').first()).toHaveText('4242')

  await expect(planNodes(page)).toHaveCount(1)
  await expect(planNodes(page).first()).toContainText('Index Scan using orders_pkey on orders')
  await expect(page.getByTestId('plan-rows')).toHaveText('rows 1 · est. 1')
  await expect(planNodes(page).first()).toContainText('(orders.id = 4242)')
})

test('the Run button runs the statement under the cursor; Run all runs every statement', async ({ page }) => {
  await setEditorText(page, 'SELECT 1 AS one;\nSELECT 2 AS two;')
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByTestId('result-table').locator('th')).toHaveText(['two'])

  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(statusLines(page)).toHaveCount(2)
  // The rows shown are the last statement's.
  await expect(page.getByTestId('result-table').locator('th')).toHaveText(['two'])
})

test('a SQL error shows Postgres’s message and position, and Run all stops there', async ({ page }) => {
  await runSql(page, 'CREATE TABLE scratch (a int);\nSELECT nope FROM scratch;\nDROP TABLE scratch;')

  await expect(statusLines(page)).toHaveCount(3)
  await expect(statusLines(page).nth(0)).toHaveAttribute('data-status', 'done')
  await expect(statusLines(page).nth(1)).toHaveAttribute('data-status', 'error')
  await expect(statusLines(page).nth(2)).toHaveAttribute('data-status', 'skipped')
  const error = page.getByTestId('sql-error')
  await expect(error).toContainText('ERROR: column "nope" does not exist')

  // The position link puts the cursor at the error: typing there edits "nope".
  await error.getByRole('button', { name: '(line 2, column 8)' }).click()
  await page.keyboard.type('X')
  await expect(editorContent(page)).toContainText('SELECT Xnope FROM scratch')
})

test('inside a transaction block, a failed query shows its own error, not "transaction is aborted"', async ({ page }) => {
  await runSql(page, 'BEGIN;\nSELECT * FROM nope;')

  await expect(statusLines(page)).toHaveCount(2)
  await expect(statusLines(page).nth(1)).toHaveAttribute('data-status', 'error')
  const error = page.getByTestId('sql-error')
  await expect(error).toContainText('ERROR: relation "nope" does not exist')
  await expect(error).not.toContainText('current transaction is aborted')
  await expect(error.getByRole('button', { name: '(line 2, column 15)' })).toBeVisible()
})

test('Postgres’s notices, DETAIL and HINT are shown', async ({ page }) => {
  await runSql(page, 'DROP TABLE IF EXISTS never_created;\nINSERT INTO categories VALUES (1, \'x\', \'x\');')
  await expect(page.getByTestId('sql-notice')).toHaveText('NOTICE: table "never_created" does not exist, skipping')
  await expect(page.getByTestId('sql-error')).toContainText('DETAIL: Key (id)=(1) already exists.')

  await runSql(page, 'SELECT lower(1);')
  await expect(page.getByTestId('sql-error')).toContainText('HINT: No function matches')
})

test('creating an index changes the plan and shows up in the schema browser', async ({ page }) => {
  const query = 'SELECT * FROM order_items WHERE product_id = 42;'
  await runSql(page, query)
  await expect(planNodes(page).first()).toContainText('Seq Scan on order_items')

  await runSql(page, `CREATE INDEX order_items_product_id_idx ON order_items (product_id);\n${query}`)
  await expect(page.getByTestId('plan-tree')).toContainText('order_items_product_id_idx')
  await expect(page.getByTestId('plan-tree')).not.toContainText('Seq Scan')
  await clickTreePath(page, ['order_items', 'Indexes'])
  await expect(treeItem(page, 'order_items_product_id_idx')).toBeVisible()

  await runSql(page, `DROP INDEX order_items_product_id_idx;\n${query}`)
  await expect(planNodes(page).first()).toContainText('Seq Scan on order_items')
  await expect(treeItem(page, 'order_items_product_id_idx')).toHaveCount(0)
})

test('a statement that isn’t a query leaves the plan pane explaining why it is empty', async ({ page }) => {
  await runSql(page, 'SELECT 1;')
  await expect(planNodes(page)).toHaveCount(1)
  await runSql(page, 'VACUUM categories;')
  await expect(statusLines(page)).toContainText('VACUUM: done')
  await expect(planNodes(page)).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Execution plan' })).toContainText('no query to plan')
})

test('a big result shows the first 1,000 rows and the total', async ({ page }) => {
  await runSql(page, 'SELECT * FROM order_items;')
  await expect(page.getByTestId('rows-cap')).toHaveText('Showing the first 1,000 of 200,582 rows.')
  await expect(page.getByTestId('result-table').locator('tbody tr')).toHaveCount(1000)
})

test('values are shown exactly as Postgres prints them, and NULL as NULL', async ({ page }) => {
  await runSql(page, `SELECT DATE '2024-02-29' AS d, 1.50::numeric(10,2) AS n, NULL AS nothing, true AS yes, '{"a":1}'::jsonb AS j;`)
  await expect(page.getByTestId('result-table').locator('tbody td')).toHaveText(['2024-02-29', '1.50', 'NULL', 't', '{"a": 1}'])
})

test('completion offers table names from the live catalog, including new tables', async ({ page }) => {
  await setEditorText(page, '')
  await page.keyboard.type('SELECT * FROM order_')
  const completions = page.locator('.cm-tooltip-autocomplete')
  await expect(completions).toContainText('order_items')

  await runSql(page, 'CREATE TABLE wishlist (id int);')
  await expect(treeItem(page, 'wishlist')).toBeVisible()
  await setEditorText(page, '')
  await page.keyboard.type('SELECT * FROM wish')
  await expect(completions).toContainText('wishlist')
})

test('the editor’s text is kept across a reload', async ({ page }) => {
  await setEditorText(page, 'SELECT 42 AS answer;')
  await page.reload()
  await expect(editorContent(page)).toHaveText('SELECT 42 AS answer;')
})
