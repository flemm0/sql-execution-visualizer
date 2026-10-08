import { expect, test, type Page } from '@playwright/test'

const PANES = ['Schema', 'SQL editor', 'Execution plan', 'Visualization', 'Results']

async function widthOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox()
  return box?.width ?? 0
}

async function heightOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox()
  return box?.height ?? 0
}

test('the app is called Pagewalk and shows the five panes', async ({ page }) => {
  await page.goto('./')
  await expect(page).toHaveTitle('Pagewalk')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Pagewalk')
  for (const pane of PANES) {
    await expect(page.getByRole('region', { name: pane })).toBeVisible()
  }
  const schema = page.getByRole('region', { name: 'Schema' })
  await expect(schema.getByTestId('table-orders')).toContainText('orders_pkey', { timeout: 60_000 })
})

test('a pane collapses to a strip and expands again from its title bar', async ({ page }) => {
  await page.goto('./')
  await expect(page.getByTestId('table-orders')).toBeVisible({ timeout: 60_000 })
  const openWidth = await widthOf(page, 'schema-pane')

  await page.getByRole('button', { name: 'Collapse Schema' }).click()
  await expect(page.getByTestId('table-orders')).toBeHidden()
  expect(await widthOf(page, 'schema-pane')).toBeLessThanOrEqual(40)

  await page.getByRole('button', { name: 'Expand Schema' }).click()
  await expect(page.getByTestId('table-orders')).toBeVisible()
  expect(await widthOf(page, 'schema-pane')).toBeCloseTo(openWidth, 0)
})

test('a bottom pane collapses to its title bar', async ({ page }) => {
  await page.goto('./')
  await page.getByRole('button', { name: 'Collapse Results' }).click()
  await expect(page.getByRole('button', { name: 'Expand Results' })).toBeVisible()
  expect(await heightOf(page, 'results-pane')).toBeLessThanOrEqual(40)
})

test('pane sizes and collapsed panes are remembered after a reload', async ({ page }) => {
  await page.goto('./')
  const startWidth = await widthOf(page, 'schema-pane')

  // Resize with the keyboard on the line between the schema browser and the rest.
  await page.getByRole('separator').first().focus()
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight')
  const resizedWidth = await widthOf(page, 'schema-pane')
  expect(resizedWidth).toBeGreaterThan(startWidth + 20)

  await page.getByRole('button', { name: 'Collapse Results' }).click()
  await expect(page.getByRole('button', { name: 'Expand Results' })).toBeVisible()

  await page.reload()
  await expect(page.getByRole('button', { name: 'Expand Results' })).toBeVisible()
  expect(await widthOf(page, 'schema-pane')).toBeCloseTo(resizedWidth, 0)
})

test.describe('with a light operating system theme', () => {
  test.use({ colorScheme: 'light' })

  test('the first visit uses the light theme', async ({ page }) => {
    await page.goto('./')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  })
})

test.describe('with a dark operating system theme', () => {
  test.use({ colorScheme: 'dark' })

  test('the first visit uses the dark theme', async ({ page }) => {
    await page.goto('./')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(10, 10, 11)')
  })

  test('the theme button switches themes, and the choice outlasts a reload', async ({ page }) => {
    await page.goto('./')
    await page.getByRole('button', { name: 'Switch to light theme' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect(page.getByRole('button', { name: 'Switch to dark theme' })).toBeVisible()
  })
})

test('the app still works when the browser blocks localStorage', async ({ page }) => {
  // Runs in the page before the app's own scripts. Written as a string because
  // e2e/ is typechecked with Node's types, which don't include the browser's Storage.
  await page.addInitScript({
    content: `
      const blocked = () => { throw new DOMException('The operation is insecure.', 'SecurityError') }
      Storage.prototype.getItem = blocked
      Storage.prototype.setItem = blocked
    `,
  })
  await page.goto('./')
  await expect(page.getByTestId('table-orders')).toBeVisible({ timeout: 60_000 })
  await page.getByRole('button', { name: 'Collapse Results' }).click()
  await page.getByRole('button', { name: /Switch to (light|dark) theme/ }).click()
  await expect(page.getByRole('button', { name: 'Expand Results' })).toBeVisible()
})

test('small windows get a "built for desktop" notice; desktop windows do not', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto('./')
  await expect(page.getByTestId('desktop-notice')).toBeVisible()

  await page.setViewportSize({ width: 1280, height: 720 })
  await expect(page.getByTestId('desktop-notice')).toBeHidden()
})
