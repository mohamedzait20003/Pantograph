import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { Capability, ReplayResult } from '@pantograph/core';

export const approvalEnum = pgEnum('approval', ['draft', 'approved']);
export const runModeEnum = pgEnum('run_mode', ['discovery', 'replay']);
export const runStateEnum = pgEnum('run_state', ['queued', 'running', 'paused', 'done', 'failed']);
export const runControlEnum = pgEnum('run_control', ['automation', 'paused', 'human', 'resuming']);
export const stepOutcomeEnum = pgEnum('step_outcome', [
  'ok',
  'business_outcome',
  'recoverable',
  'stuck',
  'failed',
]);
export const actorEnum = pgEnum('actor', ['automation', 'human']);
export const interventionStateEnum = pgEnum('intervention_state', [
  'open',
  'claimed',
  'resolved',
  'aborted',
]);
export const evidenceKindEnum = pgEnum('evidence_kind', [
  'screenshot',
  'trace',
  'journal',
  'artifact',
]);

/** The capability registry. One row per (ref, version). */
export const capabilities = pgTable(
  'capabilities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ref: text('ref').notNull(),
    version: integer('version').notNull(),
    body: jsonb('body').$type<Capability>().notNull(),
    approval: approvalEnum('approval').notNull().default('draft'),
    appId: text('app_id').notNull(),
    variant: text('variant').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('capabilities_ref_version_unique').on(table.ref, table.version),
    index('capabilities_ref_idx').on(table.ref),
  ],
);

/** Every execution, discovery or replay. */
export const runs = pgTable(
  'runs',
  {
    id: text('id').primaryKey(),
    mode: runModeEnum('mode').notNull(),
    capabilityRef: text('capability_ref'),
    goal: text('goal'),
    inputs: jsonb('inputs').$type<Record<string, unknown>>(),
    state: runStateEnum('state').notNull().default('queued'),
    control: runControlEnum('control').notNull().default('automation'),
    result: jsonb('result').$type<ReplayResult>(),
    workerAddr: text('worker_addr'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    index('runs_state_started_idx').on(table.state, table.startedAt),
    index('runs_heartbeat_idx').on(table.heartbeatAt),
  ],
);

/** The run journal: one row per executed step. */
export const steps = pgTable(
  'steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    stepId: text('step_id').notNull(),
    action: text('action').notNull(),
    resolutionTier: integer('resolution_tier'),
    outcome: stepOutcomeEnum('outcome').notNull(),
    detail: text('detail'),
    latencyMs: integer('latency_ms'),
    actor: actorEnum('actor').notNull().default('automation'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('steps_run_index_idx').on(table.runId, table.index),
  ],
);

/** Escalation requests — a run that got stuck and needs a person. */
export const interventions = pgTable(
  'interventions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    reason: text('reason').notNull(),
    expected: text('expected'),
    observed: text('observed'),
    screenshotPath: text('screenshot_path'),
    state: interventionStateEnum('state').notNull().default('open'),
    operatorNote: text('operator_note'),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (table) => [index('interventions_state_idx').on(table.state, table.raisedAt)],
);

/**
 * Pointers, never blobs.
 *
 * `path` is a filesystem path today. Everything that touches it goes through an
 * `EvidenceStore` seam, so moving to S3 becomes a change of store
 * implementation and the meaning of this string — not a schema migration. Blobs
 * in Postgres would make the database the bottleneck for screenshot-heavy runs
 * and put page content, which may contain customer data, into every backup.
 */
export const evidence = pgTable(
  'evidence',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: text('run_id').notNull().references(() => runs.id, { onDelete: 'cascade' }),
    kind: evidenceKindEnum('kind').notNull(),
    path: text('path').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('evidence_run_idx').on(table.runId, table.at)],
);

export type CapabilityRow = typeof capabilities.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type StepRow = typeof steps.$inferSelect;
export type InterventionRow = typeof interventions.$inferSelect;
export type EvidenceRow = typeof evidence.$inferSelect;
