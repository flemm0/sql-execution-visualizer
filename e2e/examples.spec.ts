import { expect, test, type Page } from '@playwright/test'
import { EXAMPLES } from '../src/examples'
import { chooseExample, editorContent, openApp, runExampleStep, setEditorText, waitForRunToFinish } from './editor'

/* The editor toolbar's Examples menu (docs/UX.md#running-statements, ADR 0041). */

function examplesButton(page: Page) {
  return page.getByRole('button', { name: 'Examples' })
}

function menu(page: Page) {
  return page.getByRole('menu', { name: 'Examples' })
}

function item(page: Page, number: number) {
  const example = EXAMPLES[number - 1]
  return page.getByRole('menuitem', { name: `${example.number}. ${example.title}`, exact: true })
}

test('the menu lists all 12 examples, each with what to watch for', async ({ page }) => {
  await openApp(page)
  await examplesButton(page).click()
  await expect(menu(page)).toBeVisible()
  await expect(menu(page).getByRole('menuitem')).toHaveCount(12)
  for (const example of EXAMPLES) {
    await expect(item(page, example.number)).toHaveAccessibleDescription(example.description)
  }
})

test('by mouse: choose an example, run it, and it animates', async ({ page }) => {
  await openApp(page)
  await examplesButton(page).click()
  await expect(examplesButton(page)).toHaveAttribute('aria-expanded', 'true')
  await item(page, 4).click()
  await expect(menu(page)).toBeHidden()

  // The example replaces the editor's text; nothing runs until Run.
  await expect(editorContent(page)).toContainText('-- Example 4: Range scan')
  await expect(editorContent(page)).toContainText('SELECT * FROM orders WHERE id BETWEEN 1000 AND 2000;')
  await expect(page.getByTestId('run-status')).toHaveCount(0)

  // The cursor is on its statement, so Run runs it.
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
  await expect(page.getByTestId('plan-node').first()).toContainText('Index Scan using orders_pkey on orders')
  // Playing: past step 0, short of the last of its 3,029 steps.
  await expect(page.getByTestId('viz-step')).toHaveText(/^step [1-9][\d,]* \/ 3,029$/)
  await expect(page.getByTestId('viz-step')).not.toHaveText('step 3,029 / 3,029')
})

test('by keyboard: open the menu, move to an example, choose it, run it, and it animates', async ({ page }) => {
  await openApp(page)
  await examplesButton(page).focus()
  await page.keyboard.press('Enter')
  // Focus starts on the first example; the arrows move it and wrap around.
  await expect(item(page, 1)).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(item(page, 12)).toBeFocused()
  await page.keyboard.press('Home')
  await expect(item(page, 1)).toBeFocused()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowDown')
  await expect(item(page, 11)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(menu(page)).toBeHidden()

  // The editor has focus, with the cursor on the statement: Cmd/Ctrl+Enter runs it.
  await expect(editorContent(page)).toBeFocused()
  await expect(editorContent(page)).toContainText('-- Example 11: Tiny tables')
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
  await expect(page.getByTestId('viz-step')).toHaveText('step 5 / 5')
  await expect(page.getByTestId('viz-caption')).toHaveText('Seq Scan on categories has no more rows: it sent 1 row to the result.')
})

test('the keyboard: ↑ on the button opens at the last example, Escape closes and returns to the button, Tab closes', async ({
  page,
}) => {
  await openApp(page)
  await examplesButton(page).focus()
  await page.keyboard.press('ArrowUp')
  await expect(item(page, 12)).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu(page)).toBeHidden()
  await expect(examplesButton(page)).toBeFocused()
  await expect(examplesButton(page)).toHaveAttribute('aria-expanded', 'false')

  await page.keyboard.press('ArrowDown')
  await expect(item(page, 1)).toBeFocused()
  await page.keyboard.press('End')
  await expect(item(page, 12)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(menu(page)).toBeHidden()
})

test('a click outside the menu closes it, and so does the button', async ({ page }) => {
  await openApp(page)
  await examplesButton(page).click()
  await expect(menu(page)).toBeVisible()
  await page.getByTestId('plan-pane').click()
  await expect(menu(page)).toBeHidden()

  await examplesButton(page).click()
  await expect(menu(page)).toBeVisible()
  await examplesButton(page).click()
  await expect(menu(page)).toBeHidden()
})

test('an item over a pane’s resize handle loads its example, and the panes keep their sizes', async ({ page }) => {
  await openApp(page)
  const results = page.getByTestId('results-pane')
  const before = await results.boundingBox()
  await examplesButton(page).click()
  // In a 1280 × 720 window, example 11, scrolled into view, sits over the handle between the visualization and the results.
  await item(page, 11).scrollIntoViewIfNeeded()
  const box = await item(page, 11).boundingBox()
  expect(before && box && box.y < before.y && before.y < box.y + box.height).toBe(true)
  await item(page, 11).click()
  await expect(editorContent(page)).toContainText('-- Example 11: Tiny tables')
  expect(await results.boundingBox()).toEqual(before)
})

test('choosing an example replaces the editor’s text, and undo brings it back', async ({ page }) => {
  await openApp(page)
  await setEditorText(page, 'SELECT 42 AS mine;')
  await chooseExample(page, EXAMPLES[6])
  await expect(editorContent(page)).not.toContainText('SELECT 42 AS mine;')

  await page.keyboard.press('ControlOrMeta+z')
  await expect(editorContent(page)).toHaveText('SELECT 42 AS mine;')
})

test('the example is remembered with the editor’s text after a reload', async ({ page }) => {
  await openApp(page)
  await chooseExample(page, EXAMPLES[8])
  await waitForRunToFinish(page)
  await page.reload()
  await openApp(page)
  await expect(editorContent(page)).toContainText('-- Example 9: Index Only Scan and the visibility map')
})

test('a multi-step example runs one statement at a time, from its comments', async ({ page }) => {
  await openApp(page)
  const example = EXAMPLES[2]
  await chooseExample(page, example)
  // The cursor starts on step 1, DROP INDEX IF EXISTS: safe to run whatever the database holds.
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.getByTestId('run-status')).toHaveAttribute('data-status', 'done')
  for (let index = 1; index < example.steps.length; index++) await runExampleStep(page, example, index)
  await expect(page.getByTestId('plan-node').first()).toContainText('Bitmap Heap Scan on order_items')
  await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
})
