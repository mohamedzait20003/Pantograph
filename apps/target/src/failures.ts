/**
 * Injectable runtime conditions, selected with `?fail=<mode>`.
 *
 * Real legacy systems fail in ways you cannot schedule: a screen hangs, the
 * session dies mid-flow, an unrelated survey interstitial appears, the host
 * rejects a write for a reason the form could not have predicted. Replay
 * error handling has to be demonstrated against those conditions, and a demo
 * that depends on catching production misbehaving is not a demo.
 *
 * So the target app can be *asked* to misbehave, reproducibly, on any route.
 * Every failure mode below maps to a recovery path the replayer is expected
 * to handle.
 */

import type { Request, RequestHandler } from 'express';

export const FAILURE_MODES = [
  /** Six-second stall before the page renders — exercises wait/timeout logic. */
  'slow_load',
  /** Session dies; the flow must detect the expiry page and re-authenticate. */
  'session_expiry',
  /** Hard 500 — a terminal condition the replayer should surface, not retry forever. */
  'app_error',
  /** Survey overlay in front of the search screen. Handled in the search route. */
  'interstitial',
  /** Server-side rejection of an otherwise valid write. Handled in the subaccount POST route. */
  'validation_error',
] as const;

export type FailureMode = (typeof FAILURE_MODES)[number];

const SLOW_LOAD_MS = 6_000;

/** Returns the requested failure mode, or `null` if absent/unrecognized. */
export function activeFailure(req: Request): FailureMode | null {
  const raw = req.query['fail'];
  if (typeof raw !== 'string') return null;
  return (FAILURE_MODES as readonly string[]).includes(raw)
    ? (raw as FailureMode)
    : null;
}

/**
 * The querystring to append to in-page form actions so a failure mode
 * survives a POST. Views read this as the `failQuery` local.
 */
export function failQuery(req: Request): string {
  const mode = activeFailure(req);
  return mode ? `?fail=${mode}` : '';
}

/**
 * Handles the modes that can be decided before any route runs. `interstitial`
 * and `validation_error` fall through, because they only mean something
 * inside a specific route.
 */
export const failureMiddleware: RequestHandler = (req, res, next) => {
  const mode = activeFailure(req);
  res.locals['failQuery'] = failQuery(req);

  // The frameset shell is exempt. It carries the mode into the content frame
  // via `failQuery` instead, so `/?fail=x` exercises the condition on the
  // screen a person actually sees - and `slow_load` is paid once, not twice.
  if (req.path === '/') {
    next();
    return;
  }

  switch (mode) {
    case 'slow_load':
      setTimeout(next, SLOW_LOAD_MS);
      return;

    case 'session_expiry':
      res.render('session-expired', { title: 'Session Ended' });
      return;

    case 'app_error':
      res.status(500).render('app-error', { title: 'System Error' });
      return;

    default:
      next();
      return;
  }
};
