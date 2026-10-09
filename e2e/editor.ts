import { expect, type Page } from '@playwright/test'
import { treeItem } from './schemaTree'

/** Opens the app and waits until Postgres is ready and the sample data is loaded. */
export async function openApp(page: Page) {
  await page.goto('./')
  await expect(treeItem(page, 'orders')).toBeVisible({ timeout: 60_000 })
}

/** The editable text area inside CodeMirror. */
export function editorContent(page: Page) {
  return page.locator('.cm-content')
}

/**
 * Replaces the editor's text, as if pasted, leaving the cursor at the end.
 * insertText adds it in one go, so completion pop-ups and auto-closed
 * brackets don't get in the way the way typing would.
 */
export async function setEditorText(page: Page, text: string) {
  await editorContent(page).click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(text)
}

/**
 * Replaces the editor's text and runs all of it with the keyboard shortcut.
 * Callers then wait for what they expect to see: Playwright's expect retries.
 */
export async function runSql(page: Page, text: string) {
  // Like a visitor, wait for the previous run to finish: until it has, Run is disabled.
  await waitForRunToFinish(page)
  await setEditorText(page, text)
  await page.keyboard.press('Shift+ControlOrMeta+Enter')
}

/**
 * Waits until the last run is completely finished: after its results show,
 * the autovacuum simulator and the schema reload still run, with Run disabled.
 */
export async function waitForRunToFinish(page: Page) {
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled()
}

/** The status lines of the last run, e.g. ["✓ SELECT: 1 row, 3.2 ms"]. */
export function statusLines(page: Page) {
  return page.getByTestId('run-status')
}

/** The headings of the plan tree's nodes, outermost first. */
export function planNodes(page: Page) {
  return page.getByTestId('plan-node')
}
