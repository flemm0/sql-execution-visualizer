import { expect, test } from '@playwright/test'
import { clickTreePath, fact, treeItem } from './schemaTree'

test.beforeEach(async ({ page }) => {
  await page.goto('./')
  await expect(treeItem(page, 'orders')).toBeVisible({ timeout: 60_000 })
})

test('opens as database → schema → Tables, with the tables still closed', async ({ page }) => {
  await expect(treeItem(page, 'postgres')).toHaveAttribute('aria-level', '1')
  await expect(treeItem(page, 'postgres')).toHaveAttribute('aria-expanded', 'true')
  await expect(treeItem(page, 'public')).toHaveAttribute('aria-level', '2')
  await expect(treeItem(page, 'public')).toHaveAttribute('aria-expanded', 'true')
  await expect(treeItem(page, 'Tables')).toHaveAttribute('aria-expanded', 'true')
  await expect(treeItem(page, 'Tables')).toContainText('5')

  const tables = treeItem(page, 'Tables').getByRole('treeitem')
  await expect(tables).toHaveText(['categories', 'customers', 'order_items', 'orders', 'products'])
  await expect(treeItem(page, 'orders')).toHaveAttribute('aria-level', '4')
  await expect(treeItem(page, 'orders')).toHaveAttribute('aria-expanded', 'false')
  // The app's own bookkeeping schema stays hidden.
  await expect(treeItem(page, 'visualizer')).toHaveCount(0)
})

test('a table opens to its columns, with types, and its indexes', async ({ page }) => {
  await clickTreePath(page, ['orders', 'Columns'])
  const columns = treeItem(treeItem(page, 'orders'), 'Columns').getByRole('treeitem')
  await expect(columns).toHaveText([
    'idinteger',
    'customer_idinteger',
    'order_datedate',
    'statustext',
    'totalnumeric(10,2)',
    'shipping_addresstext',
  ])

  await clickTreePath(page, ['orders', 'Indexes'])
  const indexes = treeItem(treeItem(page, 'orders'), 'Indexes').getByRole('treeitem')
  await expect(indexes).toHaveText(['orders_customer_id_order_date_idx', 'orders_pkey'])
})

test('selecting a table, column or index shows its details from the catalog', async ({ page }) => {
  const details = page.getByTestId('schema-details')
  await expect(details).toContainText('Select an object')

  await clickTreePath(page, ['order_items'])
  await expect(treeItem(page, 'order_items')).toHaveAttribute('aria-selected', 'true')
  await expect(details).toContainText('public.order_items')
  await expect(fact(page, 'Heap pages')).toHaveText('1,278')
  await expect(fact(page, 'Size on disk')).toHaveText('10.0 MB')

  await clickTreePath(page, ['order_items', 'Columns', 'unit_price'])
  await expect(treeItem(page, 'order_items')).toHaveAttribute('aria-selected', 'false')
  await expect(fact(page, 'Type')).toHaveText('numeric(10,2)')
  await expect(fact(page, 'Nullable')).toHaveText('no (NOT NULL)')

  await clickTreePath(page, ['customers', 'Indexes', 'customers_email_key'])
  await expect(fact(page, 'Kind')).toHaveText('unique')
  await expect(fact(page, 'B-tree levels')).toHaveText('2')
  await expect(fact(page, 'Index pages')).toHaveText('64')
  await expect(fact(page, 'Definition')).toHaveText(/CREATE UNIQUE INDEX customers_email_key .* \(email\)/)
})

test('clicking an open node closes it and hides everything under it', async ({ page }) => {
  await clickTreePath(page, ['public'])
  await expect(treeItem(page, 'public')).toHaveAttribute('aria-expanded', 'false')
  await expect(treeItem(page, 'orders')).toHaveCount(0)
})

test('the tree works from the keyboard', async ({ page }) => {
  await page.keyboard.press('Tab') // the theme button in the header
  await page.keyboard.press('Tab') // the GitHub link
  await page.keyboard.press('Tab') // the Schema pane's collapse button
  await page.keyboard.press('Tab')
  await expect(treeItem(page, 'postgres')).toBeFocused()

  // postgres → public → Tables → categories
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowDown')
  await expect(treeItem(page, 'categories')).toBeFocused()

  await page.keyboard.press('ArrowRight')
  await expect(treeItem(page, 'categories')).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowRight')
  await expect(treeItem(treeItem(page, 'categories'), 'Columns')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(treeItem(page, 'categories')).toBeFocused()
  await page.keyboard.press('ArrowLeft')
  await expect(treeItem(page, 'categories')).toHaveAttribute('aria-expanded', 'false')

  await page.keyboard.press('Enter')
  await expect(treeItem(page, 'categories')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('schema-details')).toContainText('public.categories')

  await page.keyboard.press('End')
  await expect(treeItem(page, 'products')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(treeItem(page, 'orders')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(treeItem(page, 'postgres')).toBeFocused()
})
