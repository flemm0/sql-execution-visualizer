import { expect, test, type Page } from '@playwright/test'
import { EXAMPLES } from '../src/examples'
import { editorContent, openApp, setEditorText } from './editor'

/*
 * The Examples menu in the editor toolbar (docs/UX.md#running-statements, ADR 0040).
 * Every example running end to end, from the menu, is in exit-criteria.spec.ts.
 */

function examplesButton(page: Page) {
  return page.getByRole('button', { name: 'Examples', exact: true })
}

function menu(page: Page) {
  return page.getByRole('menu', { name: 'Examples' })
}

function item(page: Page, title: string) {
  return menu(page).getByRole('menuitem', { name: title, exact: true })
}

/** The step the player shows, e.g. 120 for "step 120 / 3,410". */
async function playerStep(page: Page) {
  const text = (await page.getByTestId('viz-step').textContent()) ?? ''
  return Number(text.match(/^step ([\d,]+)/)?.[1].replace(/,/g, ''))
}

/** Waits for the animation to move on from the step it's at now. */
async function expectAnimating(page: Page) {
  const before = await playerStep(page)
  await expect.poll(() => playerStep(page)).toBeGreaterThan(before)
}

test('a visitor opens the menu with the mouse, picks an example, runs it and watches it animate', async ({ page }) => {
  await openApp(page)
  await examplesButton(page).click()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('menuitem')).toHaveCount(EXAMPLES.length)
  await expect(item(page, 'Column order in a multi-column index')).toBeVisible()

  await item(page, 'No usable index').click()
  await expect(menu(page)).toHaveCount(0)
  await expect(editorContent(page)).toContainText('-- Example 2: No usable index')
  await expect(editorContent(page)).toContainText('SELECT * FROM order_items WHERE product_id = 42;')
  // Picking doesn't run anything.
  await expect(page.getByTestId('run-status')).toHaveCount(0)

  // The cursor is on the statement and the editor has focus, so Run runs it.
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByTestId('plan-node').first()).toContainText('Seq Scan on order_items')
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
  await expectAnimating(page)
})

test('a visitor uses the menu with the keyboard alone', async ({ page }) => {
  await openApp(page)
  await examplesButton(page).focus()

  // Enter opens it on the first example; the arrows, Home and End move and wrap around.
  await page.keyboard.press('Enter')
  await expect(examplesButton(page)).toHaveAttribute('aria-expanded', 'true')
  await expect(item(page, 'Primary-key lookup')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(item(page, 'No usable index')).toBeFocused()
  await page.keyboard.press('End')
  await expect(item(page, 'Clustering factor')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(item(page, 'Primary-key lookup')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(item(page, 'Clustering factor')).toBeFocused()
  await page.keyboard.press('Home')
  await expect(item(page, 'Primary-key lookup')).toBeFocused()

  // Esc closes it and goes back to the button.
  await page.keyboard.press('Escape')
  await expect(menu(page)).toHaveCount(0)
  await expect(examplesButton(page)).toBeFocused()
  await expect(examplesButton(page)).toHaveAttribute('aria-expanded', 'false')

  // ↑ opens it on the last example; Enter picks one and moves to the editor.
  await page.keyboard.press('ArrowUp')
  await expect(item(page, 'Clustering factor')).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await expect(item(page, 'Top-N')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(menu(page)).toHaveCount(0)
  await expect(editorContent(page)).toBeFocused()
  await expect(editorContent(page)).toContainText('-- Example 10: Top-N')

  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByTestId('plan-node').nth(1)).toContainText(
    'Index Scan Backward using orders_customer_id_order_date_idx on orders',
  )
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
  await expect(page.getByTestId('viz-caption')).toBeVisible()
})

test('picking an example replaces the editor’s text, and undo brings it back', async ({ page }) => {
  await openApp(page)
  await setEditorText(page, 'SELECT 42 AS mine;')
  await examplesButton(page).click()
  await item(page, 'Tiny tables').click()
  await expect(editorContent(page)).toContainText('SELECT * FROM categories WHERE id = 3;')
  await expect(editorContent(page)).not.toContainText('SELECT 42 AS mine;')

  await page.keyboard.press('ControlOrMeta+z')
  await expect(editorContent(page)).toHaveText('SELECT 42 AS mine;')
})

test('a click outside the menu closes it without changing the editor', async ({ page }) => {
  await openApp(page)
  await setEditorText(page, 'SELECT 42 AS mine;')
  await examplesButton(page).click()
  await expect(menu(page)).toBeVisible()
  await page.getByRole('region', { name: 'Execution plan' }).click()
  await expect(menu(page)).toHaveCount(0)
  await expect(editorContent(page)).toHaveText('SELECT 42 AS mine;')
})
