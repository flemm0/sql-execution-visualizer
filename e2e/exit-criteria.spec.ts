import { expect, test, type Page } from '@playwright/test'
import { commandName, splitStatements } from '../src/db/statements'
import { EXAMPLES, count, type ExampleStep } from '../src/examples'
import { editorContent, openApp, waitForRunToFinish } from './editor'

/*
 * The milestones' exit criteria (docs/ROADMAP.md), as a visitor sees them.
 * CI runs this against the local build on every PR, and the Live check
 * workflow runs it against the deployed site after every deploy.
 *
 * Each example is picked from the Examples menu and run the way its editor
 * text says: one statement at a time, top to bottom. Every query must replay
 * with "✓ Replay matches Postgres", get the plan the example describes
 * (src/examples.ts), and animate to its last step. M3's ~30 s budget is
 * checked once condensing lands.
 */

/** M2's exit criteria: these examples were the first to animate end to end. */
const M2_EXAMPLES = new Set([1, 2, 4, 11])

/** The editor line holding a step's statement; `nth` counts earlier steps with the same SQL. */
function statementLine(page: Page, sql: string, nth: number) {
  const exact = new RegExp(`^${escapeRegExp(sql + ';')}$`)
  return editorContent(page).locator('.cm-line').filter({ hasText: exact }).nth(nth)
}

/** What the page shows once a step has run, so the next step waits for its own results, not the last one's. */
async function expectStepDone(page: Page, step: ExampleStep) {
  const status = page.getByTestId('run-status')
  if (!step.expect) {
    await expect(status).toContainText(`${commandName(splitStatements(step.sql)[0])}: `)
    return
  }
  await expect(status).toContainText(`SELECT: ${count(step.expect.rows, 'row')}`)
  await expect(page.getByTestId('plan-node')).toHaveText(step.expect.plan.map((title) => new RegExp(`^${escapeRegExp(title)}`)))
  if (step.expect.heapFetches) {
    // Each test starts with the sample data as it was generated: the example's first run.
    await expect(page.getByTestId('plan-node').first()).toContainText(new RegExp(`Heap Fetches\\s*${step.expect.heapFetches.first}\\b`))
  }
}

/** Text to match exactly inside a regular expression. */
function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

for (const example of EXAMPLES) {
  const milestone = M2_EXAMPLES.has(example.id) ? 'M2' : 'M3'
  test(`${milestone}: example ${example.id}, ${example.title}, from the Examples menu, animates end to end and validates`, async ({
    page,
  }) => {
    // Consecutive steps must look different once run, or a step could pass on the last one's results.
    for (const [index, step] of example.steps.entries()) {
      if (index > 0) expect(JSON.stringify(step.expect ?? step.sql)).not.toBe(JSON.stringify(example.steps[index - 1].expect ?? example.steps[index - 1].sql))
    }

    await openApp(page)
    await page.getByRole('button', { name: 'Examples', exact: true }).click()
    await page.getByRole('menuitem', { name: example.title, exact: true }).click()

    for (const [index, step] of example.steps.entries()) {
      await waitForRunToFinish(page)
      const nth = example.steps.slice(0, index).filter((earlier) => earlier.sql === step.sql).length
      await statementLine(page, step.sql, nth).click()
      await page.keyboard.press('ControlOrMeta+Enter')
      await expectStepDone(page, step)
      if (!step.expect) continue

      await expect(page.getByTestId('replay-status')).toContainText('✓ Replay matches Postgres')
      await expect(page.getByTestId('viz-mismatch')).toHaveCount(0)
      await page.getByTestId('player').getByRole('button', { name: 'To the end', exact: true }).click()
      const rows = count(step.expect.rows, 'row')
      await expect(page.getByTestId('viz-caption')).toHaveText(`${step.expect.plan[0]} has no more rows: it sent ${rows} to the result.`)
      // At the last step the whole result shows.
      await expect(page.getByTestId('rows-filling')).toHaveCount(0)
    }
  })
}
