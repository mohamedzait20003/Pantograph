import { z } from 'zod';
import { CheckpointSchema, BusinessOutcomeDetectorSchema, RecoverableDetectorSchema } from './detectors.js';
import { InputSpecSchema, IoNameSchema, OutputSpecSchema } from './io.js';
import { LocatorBundleSchema } from './locator.js';
import { StepSchema } from './step.js';

/**
 * The capability: a recorded flow, promoted to a callable, reviewable contract.
 *
 * This one structure serves four consumers, which is why it looks the way it
 * does: the discovery agent emits it, the replay engine executes it, an AI
 * agent reads `description`/`inputs`/`outputs` to decide whether to call it,
 * and a human reviews it in a pull request. Anything that only one of those
 * four needs does not belong here.
 */

/**
 * `variant` is the tenant/vendor-config seam. Two institutions running the same
 * vendor product at the same version still differ in labels and branding, so
 * the variant — not the app id — is what an override keys on.
 */
export const AppRefSchema = z.object({
  id: z.string().min(1),
  variant: z.string().min(1),
  baseVersion: z.string().optional(),
});

/**
 * What produced this artifact — and deliberately nothing more.
 *
 * NO model transcript and NO recorded input values, ever. Two reasons, and both
 * are load-bearing:
 *
 *   1. Regulated data. The discovery run drove a live banking UI with real
 *      member identifiers. Persisting that transcript would put customer data
 *      into every artifact, every pull request diff, and every backup of them.
 *   2. Decoupling. The artifact is the contract, not a record of the session
 *      that produced it. If replay behaviour ever depended on transcript
 *      content, the artifact would no longer be self-contained and "no model in
 *      the decision loop" would quietly stop being true.
 *
 * This is a `strictObject` on purpose: an artifact carrying an extra
 * `transcript` or `inputValues` key fails to parse rather than silently
 * smuggling regulated data through. The rest of the schema stays permissive for
 * forward compatibility; this one object does not.
 */
export const ProvenanceSchema = z.strictObject({
  recordedAt: z.iso.datetime(),
  /** Which model discovered the flow — for auditing a bad recording later. */
  model: z.string().min(1),
  targetUrl: z.string().min(1),
  /** Points at the run record in the API; the run holds the detail, not this. */
  runId: z.string().min(1),
});

/**
 * Per-variant specialization: the alternative to re-recording a flow for every
 * tenant.
 *
 * Keyed variant id → step id → the fields that may differ. Only locator and
 * value level fields are overridable — never the step list. If tenant B needs a
 * *different sequence of steps*, that is a different capability, not an
 * override; letting overrides restructure the flow would mean the steps a
 * reviewer approved are not the steps that run.
 */
export const StepOverrideSchema = z.object({
  target: LocatorBundleSchema.optional(),
  value: z.string().optional(),
  url: z.string().optional(),
});

export const OverridesSchema = z.record(z.string(), z.record(z.string(), StepOverrideSchema));

const PARAM_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/** Extracts `{{param}}` token names from an interpolatable string. */
export function referencedParams(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PARAM_PATTERN)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

export const CapabilitySchema = z
  .object({
    /** Bumps only when the *schema* changes shape. Distinct from `version`. */
    schemaVersion: z.literal(1),
    /** Stable dotted id, e.g. 'corebank.member.savings_balance'. */
    ref: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/, {
      error: "ref must be a dotted lowercase id, e.g. 'corebank.member.savings_balance'.",
    }),
    /** Bumps when the steps or the input/output contract change. */
    version: z.number().int().positive(),
    name: z.string().min(1),
    /** What an AI agent reads to decide whether this capability answers its goal. */
    description: z.string().min(1),
    app: AppRefSchema,
    /**
     * The gate for unattended replay. A `draft` capability is executable only
     * with a human watching; promotion to `approved` is the review event.
     */
    approval: z.enum(['draft', 'approved']),
    inputs: z.record(IoNameSchema, InputSpecSchema),
    outputs: z.record(IoNameSchema, OutputSpecSchema),
    steps: z.array(StepSchema).min(1),
    /** The top-level assertion that the flow reached its goal state. */
    checkpoint: CheckpointSchema,
    businessOutcomes: z.array(BusinessOutcomeDetectorSchema),
    recoverable: z.array(RecoverableDetectorSchema),
    provenance: ProvenanceSchema,
    overrides: OverridesSchema.optional(),
  })
  .superRefine((capability, ctx) => {
    const stepIds = new Set<string>();

    capability.steps.forEach((step, index) => {
      if (stepIds.has(step.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate step id '${step.id}'. Step ids anchor overrides and failure reports, so they must be unique.`,
          path: ['steps', index, 'id'],
        });
      }
      stepIds.add(step.id);

      // An extract that binds to an undeclared output produces a value nothing
      // can consume — the capability would report success while silently
      // dropping the answer it was asked for.
      if (step.action === 'extract' && !(step.as in capability.outputs)) {
        ctx.addIssue({
          code: 'custom',
          message: `Step '${step.id}' extracts into '${step.as}', which is not a declared output.`,
          path: ['steps', index, 'as'],
        });
      }

      // Interpolating an undeclared parameter would send the literal text
      // '{{memberId}}' into a form field at replay time.
      const interpolated =
        step.action === 'navigate'
          ? step.url
          : step.action === 'type' || step.action === 'select'
            ? step.value
            : null;

      if (interpolated !== null) {
        for (const param of referencedParams(interpolated)) {
          if (!(param in capability.inputs)) {
            ctx.addIssue({
              code: 'custom',
              message: `Step '${step.id}' references '{{${param}}}', which is not a declared input.`,
              path: ['steps', index],
            });
          }
        }
      }
    });

    // The dual of the extract check: a declared output that no step produces is
    // a promise in the tool signature that replay cannot keep.
    for (const outputName of Object.keys(capability.outputs)) {
      const produced = capability.steps.some(
        (step) => step.action === 'extract' && step.as === outputName,
      );
      if (!produced) {
        ctx.addIssue({
          code: 'custom',
          message: `Output '${outputName}' is declared but no extract step produces it.`,
          path: ['outputs', outputName],
        });
      }
    }

    // An override keyed to a step id that no longer exists is dead config, and
    // it is the exact thing left behind when someone edits the steps.
    for (const [variant, byStep] of Object.entries(capability.overrides ?? {})) {
      for (const stepId of Object.keys(byStep)) {
        if (!stepIds.has(stepId)) {
          ctx.addIssue({
            code: 'custom',
            message: `Override for variant '${variant}' targets unknown step '${stepId}'.`,
            path: ['overrides', variant, stepId],
          });
        }
      }
    }
  });

export type AppRef = z.infer<typeof AppRefSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type StepOverride = z.infer<typeof StepOverrideSchema>;
export type Overrides = z.infer<typeof OverridesSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
