import { z } from 'zod';


export const ReplayResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    outputs: z.record(z.string(), z.string()),
    runId: z.string().min(1),
    durationMs: z.number().nonnegative(),
    resolutionTiers: z.array(z.number().int().min(1).max(5)),
  }),

  z.object({
    status: z.literal('business_outcome'),
    outcome: z.string().min(1),
    detail: z.string().min(1),
    runId: z.string().min(1),
  }),

  z.object({
    status: z.literal('failed'),
    stepId: z.string().min(1),
    stepIndex: z.number().int().nonnegative(),
    expected: z.string().min(1),
    observed: z.string().min(1),
    evidence: z.array(z.string()),
    runId: z.string().min(1),
  }),
]);

/**
 * The per-step outcome inside the replay loop. Internal to the engine — it is
 * what the loop switches on to decide whether to continue, stop with an answer,
 * apply a recovery, or escalate.
 *
 * `stuck` is the escalation trigger: nothing matched, recovery is exhausted or
 * inapplicable, and the engine refuses to guess. It becomes a `failed` result
 * and a human gets asked.
 */
export const StepOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ok'), tier: z.number().int().min(1).max(5) }),
  z.object({
    kind: z.literal('business_outcome'),
    name: z.string().min(1),
    detail: z.string().min(1),
  }),
  z.object({
    kind: z.literal('recoverable'),
    name: z.string().min(1),
    attempt: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('stuck'),
    expected: z.string().min(1),
    observed: z.string().min(1),
  }),
]);

export type ReplayResult = z.infer<typeof ReplayResultSchema>;
export type StepOutcome = z.infer<typeof StepOutcomeSchema>;
