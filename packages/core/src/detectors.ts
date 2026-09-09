import { z } from 'zod';
import { LocatorBundleSchema } from './locator.js';

/**
 * The error taxonomy.
 *
 * Three concepts that must never be conflated, because the most common design
 * mistake in this problem is treating "no such member" as a crash:
 *
 *   1. BUSINESS OUTCOME — the app worked correctly and the answer is "no".
 *      MEMBER_NOT_FOUND is a *result*, not a failure. The caller needs it, and
 *      retrying it is pointless: the member will still not exist.
 *   2. RECOVERABLE — a transient obstacle between us and the goal. A survey
 *      interstitial is not an answer to anything; clear it and carry on.
 *   3. HARD FAILURE — everything else.
 *
 * There is deliberately no `HardFailureDetector` type below. A hard failure is
 * defined by *exhaustion*, not by recognition: nothing matched a business
 * outcome, nothing matched a recoverable condition, and the checkpoint did not
 * pass. Giving it a detector type would imply we can enumerate the ways a
 * legacy system breaks, and inviting an agent to classify an unknown page as a
 * known failure is how a replay ends up reporting a confident wrong answer.
 * The absence of the type is the design.
 */

/** How a condition is recognized on the page. */
export const MatchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), value: z.string().min(1) }),
  z.object({ kind: z.literal('urlPattern'), value: z.string().min(1) }),
  /** Recognized by something being gone — e.g. the interstitial we dismissed. */
  z.object({ kind: z.literal('absent'), target: LocatorBundleSchema }),
]);

/**
 * The condition asserted to confirm the flow actually reached the state we
 * expect, rather than assuming a click worked. Without this, a replay that
 * silently lands on an error page will happily extract garbage from it.
 */
export const CheckpointSchema = z.object({
  match: MatchSchema,
  description: z.string().min(1),
  timeoutMs: z.number().int().positive(),
});

/** Detector names are SCREAMING_SNAKE so they read as stable enum members to callers. */
export const DetectorNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/, {
  error: 'Detector names are SCREAMING_SNAKE_CASE, e.g. MEMBER_NOT_FOUND.',
});

/**
 * A legitimate result the caller needs to know about.
 *
 * `terminal` is a literal `true`, not a boolean. A business outcome always ends
 * the run — that is what makes it an outcome rather than an obstacle — so it is
 * not a field an artifact author can flip to keep going.
 */
export const BusinessOutcomeDetectorSchema = z.object({
  name: DetectorNameSchema,
  match: MatchSchema,
  /** Human-readable explanation surfaced to the caller alongside the name. */
  detail: z.string().min(1),
  terminal: z.literal(true),
});

/**
 * The handling action is a closed union of three bounded operations, never a
 * script or a callback. A recovery path that can express arbitrary behaviour is
 * a second automation engine hiding inside the error handler — unreviewable in
 * a pull request, and able to mutate state while nominally "recovering".
 */
export const RecoverableHandleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('click'), target: LocatorBundleSchema }),
  z.object({ kind: z.literal('wait'), ms: z.number().int().positive().max(30_000) }),
  z.object({ kind: z.literal('reload') }),
]);

export const RecoverableDetectorSchema = z.object({
  name: DetectorNameSchema,
  match: MatchSchema,
  handle: RecoverableHandleSchema,
  /** Bounded by construction: an unbounded retry is an infinite loop with good intentions. */
  maxTimes: z.number().int().positive().max(5),
});

export type Match = z.infer<typeof MatchSchema>;
export type Checkpoint = z.infer<typeof CheckpointSchema>;
export type BusinessOutcomeDetector = z.infer<typeof BusinessOutcomeDetectorSchema>;
export type RecoverableHandle = z.infer<typeof RecoverableHandleSchema>;
export type RecoverableDetector = z.infer<typeof RecoverableDetectorSchema>;
