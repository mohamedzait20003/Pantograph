import { z } from 'zod';


export const FrameChainSchema = z.array(z.string().min(1));


export const LocatorCandidateSchema = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('role'),
    tier: z.literal(1),
    role: z.string().min(1),
    name: z.string().min(1),
  }),

  /** Form control resolved through its bound `<label for>` text. */
  z.object({
    by: z.literal('label'),
    tier: z.literal(2),
    label: z.string().min(1),
  }),

  /**
   * A table cell anchored by its row header and column header text. This is
   * what makes a data grid readable without counting `<td>` positions: the
   * target app puts `<th scope="row">` on every account type specifically so
   * `{ row: 'Savings', column: 'Balance' }` resolves structurally.
   */
  z.object({
    by: z.literal('cell'),
    tier: z.literal(3),
    row: z.string().min(1),
    column: z.string().min(1),
  }),

  /** An element by its visible text. Same tier as `cell`: content-dependent. */
  z.object({
    by: z.literal('text'),
    tier: z.literal(3),
    text: z.string().min(1),
    exact: z.boolean().optional(),
  }),

  /** A scoped path within the frame. Brittle — the last DOM-based resort. */
  z.object({
    by: z.literal('structural'),
    tier: z.literal(4),
    path: z.string().min(1),
  }),

  /**
   * An x/y point. This is the escape hatch for surfaces that expose no
   * queryable tree at all — a Win32 desktop app, a Citrix session, a canvas
   * renderer — which is why the schema carries it even though the web
   * implementation should never emit one.
   *
   * `requiresApproval` is a literal `true` rather than a boolean: it is not a
   * setting the recorder gets to turn off. Coordinates are never selected
   * automatically on a web surface, and a human has to sign off before replay
   * will execute one, because a blind click at (412, 388) does whatever
   * happens to be under that point today.
   */
  z.object({
    by: z.literal('coordinates'),
    tier: z.literal(5),
    x: z.number(),
    y: z.number(),
    requiresApproval: z.literal(true),
  }),
]);

export const LocatorBundleSchema = z.object({
  frame: FrameChainSchema,
  candidates: z.array(LocatorCandidateSchema).min(1, { error: 'A locator bundle needs at least one candidate strategy.' }),
  description: z.string().min(1),
}).refine((bundle) => {
  let previous = 0;

  for (const candidate of bundle.candidates) {
    if (candidate.tier < previous)
      return false;

    previous = candidate.tier;
  }

  return true;
},
{
  error: 'Locator candidates must be ordered by ascending tier — replay tries them in array order, so an out-of-order bundle would silently prefer a weaker strategy.',
  path: ['candidates'],
});

export type FrameChain = z.infer<typeof FrameChainSchema>;
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;
export type LocatorBundle = z.infer<typeof LocatorBundleSchema>;
