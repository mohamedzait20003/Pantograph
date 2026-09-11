import { errors, type Page } from 'playwright';

/**
 * The waiting strategy, as one named seam instead of `waitForTimeout` calls
 * scattered through the engine.
 *
 * There is no fixed sleep in here, and there must never be one in the replay
 * path. A fixed sleep is wrong in both directions at once: too short on the
 * slow day and the step runs against a half-rendered page, too long on every
 * other day and a forty-step replay spends most of its wall clock doing
 * nothing. Waiting on a condition costs exactly as long as the condition
 * takes.
 *
 * The target is server-rendered with full page loads and no client-side JS,
 * so "the load event has fired in every frame" genuinely means stable. A
 * surface with spinners or XHR-driven rendering replaces this function, not
 * the callers.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export async function waitForStable(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const started = Date.now();
  const remaining = (): number => Math.max(1, timeoutMs - (Date.now() - started));

  await page.waitForLoadState('load', { timeout: remaining() });

  // The top-level load event fires only after child frames have loaded, but a
  // frame added by script afterwards would not be covered - so ask each frame
  // directly. A frame detaching while we wait is not an error; it is gone.
  await Promise.all(
    page.frames().map(async (frame) => {
      try {
        await frame.waitForLoadState('load', { timeout: remaining() });
      } catch (error) {
        if (error instanceof errors.TimeoutError) throw error;
        if (frame.isDetached()) return;
        throw error;
      }
    }),
  );
}

/**
 * Prepares to settle the page after an action that may or may not navigate.
 *
 * Call it *before* the action, await the returned function *after*. Playwright
 * no longer waits for click-initiated navigations itself, so a click that
 * submits a form returns before the new document exists; the next resolve
 * would then run against the old one. Arming a listener first means a fast
 * navigation cannot be missed.
 *
 * The grace window is the one bounded fixed cost in this file, paid only on
 * actions that turn out not to navigate. It is a cap on how long to wait for
 * a navigation to *begin*, not a sleep that always elapses - the moment a
 * frame navigates, the race resolves and the full load wait takes over.
 */
export function armSettle(
  page: Page,
  options: { graceMs?: number; timeoutMs?: number } = {},
): () => Promise<void> {
  const graceMs = options.graceMs ?? 250;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let detach: () => void = () => {};
  const navigated = new Promise<boolean>((resolve) => {
    const handler = (): void => resolve(true);
    page.on('framenavigated', handler);
    detach = () => page.off('framenavigated', handler);
  });

  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    });

    try {
      const sawNavigation = await Promise.race([navigated, grace]);
      if (sawNavigation) await waitForStable(page, timeoutMs);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      detach();
    }
  };
}
