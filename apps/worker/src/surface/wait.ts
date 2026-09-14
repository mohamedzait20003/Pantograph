import { errors, type Frame, type Page, type Request } from 'playwright';

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
 * would then run against the old one. Arming listeners first means a fast
 * navigation cannot be missed.
 *
 * Two signals, because they answer different questions. The `request` event
 * for a navigation request fires the instant a form submits - that is how we
 * learn a navigation has *begun*, and it arrives immediately even when the
 * server takes six seconds to answer. `framenavigated` fires when the new
 * document *commits*, which is when it is safe to wait for load. Listening
 * only for the commit, as a first version of this did, misses every slow
 * server: the grace window expires while the request is still in flight and
 * the engine carries on against the old page.
 *
 * The grace window is the one bounded fixed cost in this file, paid only on
 * actions that turn out not to navigate. It caps how long to wait for a
 * navigation to *begin*; once one has begun, the full timeout applies.
 */
export function armSettle(
  page: Page,
  options: { graceMs?: number; timeoutMs?: number } = {},
): () => Promise<void> {
  const graceMs = options.graceMs ?? 250;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const detachers: (() => void)[] = [];

  const started = new Promise<boolean>((resolve) => {
    const onRequest = (request: Request): void => {
      if (request.isNavigationRequest()) resolve(true);
    };
    page.on('request', onRequest);
    detachers.push(() => page.off('request', onRequest));
  });

  const committed = new Promise<void>((resolve) => {
    const onNavigated = (_frame: Frame): void => resolve();
    page.on('framenavigated', onNavigated);
    detachers.push(() => page.off('framenavigated', onNavigated));
  });

  return async () => {
    const deadline = Date.now() + timeoutMs;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let commitTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      const grace = new Promise<boolean>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), graceMs);
      });
      const sawNavigation = await Promise.race([started, grace]);
      if (!sawNavigation) return;

      const commitTimeout = new Promise<never>((_, reject) => {
        commitTimer = setTimeout(
          () => reject(new errors.TimeoutError(`navigation did not commit within ${timeoutMs}ms`)),
          Math.max(1, deadline - Date.now()),
        );
      });
      await Promise.race([committed, commitTimeout]);

      await waitForStable(page, Math.max(1, deadline - Date.now()));
    } finally {
      if (graceTimer !== undefined) clearTimeout(graceTimer);
      if (commitTimer !== undefined) clearTimeout(commitTimer);
      for (const detach of detachers) detach();
    }
  };
}
