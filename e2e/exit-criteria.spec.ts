import { expect, test } from '@playwright/test'
import { EXAMPLES } from '../src/examples'
import { chooseExample, openApp, rowCount, runExampleStep } from './editor'

/*
 * The milestones' exit criteria (docs/ROADMAP.md), as a visitor sees them.
 * CI runs this against the local build on every PR, and the Live check
 * workflow runs it against the deployed site after every deploy.
 *
 * M2: examples 1, 2, 4 and 11 animate end to end and validate.
 * M3: all 12 examples animate within budget and validate. Each example is
 * chosen from the Examples menu, and each of its statements run in turn, as a
 * visitor would; every query must replay, match Postgres, and play to its end.
 * Not here yet: the ~30 s budget, which waits on condensing.
 */

test.describe('all 12 examples, from the Examples menu, animate end to end and validate', () => {
  for (const example of EXAMPLES) {
    test(`example ${example.number}: ${example.title}`, async ({ page }) => {
      test.slow()
      await openApp(page)
      await chooseExample(page, example)
      for (const [index, step] of example.steps.entries()) {
        await runExampleStep(page, example, index)
        const where = `step ${index + 1}: ${step.sql}`
        if (step.plan === undefined) {
          await expect(page.getByTestId('run-status'), where).toHaveAttribute('data-status', 'done')
          continue
        }
        const rows = rowCount(step.plan.rows)
        await expect(page.getByTestId('run-status'), where).toContainText(`SELECT: ${rows}`)
        await expect(page.getByTestId('replay-status'), where).toContainText('✓ Replay matches Postgres')
        await expect(page.getByTestId('viz-mismatch'), where).toHaveCount(0)
        await expect(page.getByTestId('plan-node'), where).toHaveText(step.plan.nodes.map((node) => new RegExp(`^${escape(node)}`)))

        await page.getByTestId('player').getByRole('button', { name: 'To the end', exact: true }).click()
        await expect(page.getByTestId('viz-caption'), where).toHaveText(`${step.plan.nodes[0]} has no more rows: it sent ${rows} to the result.`)
        // At the last step the whole result shows.
        await expect(page.getByTestId('rows-filling'), where).toHaveCount(0)
      }
    })
  }
})

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
