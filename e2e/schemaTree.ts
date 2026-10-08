import type { Locator, Page } from '@playwright/test'

/** A schema tree row by its exact name, e.g. "orders" or "Indexes", searched inside `scope`. */
export function treeItem(scope: Page | Locator, name: string) {
  return scope.getByRole('treeitem', { name, exact: true })
}

/**
 * Clicks down the schema tree like a visitor, e.g. ['orders', 'Indexes', 'orders_pkey']:
 * opens each node on the way that's still closed, then clicks the last one to select it.
 * Each name is looked up inside the previous node, so "Indexes" means orders' Indexes folder.
 */
export async function clickTreePath(page: Page, names: string[]) {
  let scope: Page | Locator = page
  for (const [position, name] of names.entries()) {
    const item = treeItem(scope, name)
    const isLast = position === names.length - 1
    if (isLast || (await item.getAttribute('aria-expanded')) === 'false') {
      // The row itself, not the <li>, which also contains the open children.
      await item.locator(':scope > div').click()
    }
    scope = item
  }
}

/** The value next to `label` in the details panel under the tree, e.g. fact(page, 'Heap pages'). */
export function fact(page: Page, label: string) {
  return page
    .getByTestId('schema-details')
    .locator('dt', { hasText: label })
    .locator('xpath=following-sibling::dd[1]')
}
