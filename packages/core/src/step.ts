import { z } from 'zod';
import { CheckpointSchema } from './detectors.js';
import { LocatorBundleSchema } from './locator.js';


export const RiskClassSchema = z.enum(['safe', 'confirm', 'blocked']);
export type RiskClass = z.infer<typeof RiskClassSchema>;

const StepIdSchema = z.string().min(1);

/**
 * The risk a recorder should assume when it has no better information.
 *
 * The interesting case is the `default` branch. An action this build does not
 * recognize — an artifact written against a newer schema, or a step type added
 * by another surface implementation — returns `confirm`, not `safe`.
 *
 * Defaulting to `safe` would mean that the way to get an unreviewed mutation
 * executed unattended is to emit an action name this build has never heard of.
 * An unknown action is precisely the case where we cannot reason about the
 * blast radius, so it fails closed: worst case a human is asked to approve a
 * harmless step, versus worst case an unattended replay moves money.
 */
export function defaultRiskForAction(action: string): RiskClass {
  switch (action) {
    case 'navigate':
    case 'extract':
    case 'assert':
      return 'safe';
    case 'click':
    case 'type':
    case 'select':
      return 'confirm';
    default:
      return 'confirm';
  }
}

const stepBase = {
  id: StepIdSchema,
  note: z.string().optional(),
  risk: RiskClassSchema,
};

export const StepSchema = z.discriminatedUnion('action', [
  z.object({
    ...stepBase,
    action: z.literal('navigate'),
    url: z.string().min(1),
  }),

  z.object({
    ...stepBase,
    action: z.literal('click'),
    target: LocatorBundleSchema,
  }),

  z.object({
    ...stepBase,
    action: z.literal('type'),
    target: LocatorBundleSchema,
    value: z.string(),
  }),

  z.object({
    ...stepBase,
    action: z.literal('select'),
    target: LocatorBundleSchema,
    value: z.string(),
  }),

  z.object({
    ...stepBase,
    action: z.literal('extract'),
    target: LocatorBundleSchema,
    as: z.string().min(1),
  }),

  z.object({
    ...stepBase,
    action: z.literal('assert'),
    check: CheckpointSchema,
  }),
]);

export type Step = z.infer<typeof StepSchema>;
export type StepAction = Step['action'];
