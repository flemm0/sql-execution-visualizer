import { expect, type Page } from '@playwright/test'

/*
 * Moving the player to an event of the trace. Long traces play condensed
 * (ADR 0041), so step n isn't event n: the player says how many events have
 * happened (data-events-done), and a stretch can be expanded to reach an
 * event inside it.
 */

/** How many trace events have happened at the player's step. */
async function eventsDone(page: Page): Promise<number> {
  return Number(await page.getByTestId('player').getAttribute('data-events-done'))
}

/**
 * Moves the player to the step of the `events`th event alone, so its caption
 * is that event's: expanding the stretch it's in, if it's in one.
 */
export async function seekToEvent(page: Page, events: number) {
  const slider = page.getByRole('slider', { name: 'Timeline' })
  const timeline = {
    // Moves the timeline, and waits for the player to get there.
    async fill(position: string) {
      await slider.fill(position)
      await expect(page.getByTestId('viz-step')).toHaveText(new RegExp(`^step ${Number(position).toLocaleString('en-US')} /`))
    },
  }
  let low = 0
  let high = Number(await page.getByTestId('player').getAttribute('data-steps'))
  // The first step after which at least that many events have happened.
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    await timeline.fill(String(middle))
    if ((await eventsDone(page)) >= events) high = middle
    else low = middle + 1
  }
  await timeline.fill(String(low))
  const stretch = page.locator('[data-testid="viz-stretch"][data-kind="stretch"]')
  if ((await stretch.count()) === 0) return
  // Inside a stretch: expanded, the player is on its first event; then one step per event.
  await stretch.getByRole('button', { name: 'Expand' }).click()
  const first = await eventsDone(page)
  await timeline.fill(String(low + events - first))
  expect(await eventsDone(page)).toBe(events)
}
