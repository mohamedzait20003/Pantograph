import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { ReplayResult } from '@pantograph/core';

import type { Database } from './index.js';
import { runs, steps, type RunRow } from './schema.js';

/**
 * Run lifecycle queries.
 *
 * The claim is the single most important query in the system: it is the only
 * thing standing between two workers and the same browser session. Everything
 * else here exists to detect and clean up after a worker that died holding one.
 */

/** The reason recorded when a run is reaped. Stable enough to alert on. */
export const SESSION_LOST = 'SESSION_LOST';

/**
 * Atomically claims the oldest queued run for one worker.
 *
 * The correctness rests on `FOR UPDATE SKIP LOCKED` inside the subquery. The
 * inner select locks the row it picks; a concurrent claim running at the same
 * instant skips that locked row instead of blocking on it and picks the next
 * one. Two workers therefore cannot receive the same run, and neither has to
 * wait for the other — which is what makes this scale past one worker without
 * a separate lock service or an advisory-lock dance.
 *
 * Doing it as a single conditional UPDATE also means there is no window between
 * "choose a run" and "mark it mine" for a crash to land in.
 *
 * Returns `null` when the queue is empty; the caller polls.
 */
export async function claimNextRun(db: Database, workerAddr: string): Promise<RunRow | null> {
  const now = new Date();

  const claimed = await db
    .update(runs)
    .set({ state: 'running', workerAddr, claimedAt: now, heartbeatAt: now })
    .where(
      eq(
        runs.id,
        sql`(
          SELECT ${runs.id} FROM ${runs}
          WHERE ${runs.state} = 'queued'
          ORDER BY ${runs.startedAt}
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )`,
      ),
    )
    .returning();

  return claimed[0] ?? null;
}

/**
 * Bumps the heartbeat for a run this worker still holds.
 *
 * Scoped to `running` and `paused` — a paused run still has a live browser and
 * a worker holding it, so it must keep beating. Returns false when no row was
 * updated, which is how a worker discovers it has already been reaped and
 * should stop rather than keep driving a session nobody is watching.
 */
export async function heartbeat(db: Database, runId: string): Promise<boolean> {
  const updated = await db
    .update(runs)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(runs.id, runId), inArray(runs.state, ['running', 'paused'])))
    .returning({ id: runs.id });

  return updated.length > 0;
}

/**
 * Fails runs whose worker has stopped heartbeating.
 *
 * These are NOT re-queued, and that is the important decision. Two reasons:
 *
 *   1. The browser state is gone. A run is a position in a stateful session —
 *      logged in, three screens deep, a form half filled. That lives in the
 *      dead worker's memory and cannot be reconstructed elsewhere, so handing
 *      the run to another worker would restart it from nothing while pretending
 *      to resume.
 *   2. A replay may already have caused a side effect. If the worker died after
 *      submitting the sub-account form but before recording the result, a
 *      silent retry opens a second sub-account. On a bank system, at-least-once
 *      delivery of a mutation is a defect, not a feature.
 *
 * So a lost session becomes a terminal failure that a human looks at. Deciding
 * whether the work actually landed requires checking the target system, and
 * that judgement is not one this process can make.
 */
export async function reapStaleRuns(db: Database, thresholdMs: number): Promise<RunRow[]> {
  const cutoff = new Date(Date.now() - thresholdMs);

  return db.transaction(async (tx) => {
    const stale = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(inArray(runs.state, ['running', 'paused']), lt(runs.heartbeatAt, cutoff)))
      .for('update', { skipLocked: true });

    const reaped: RunRow[] = [];

    for (const { id } of stale) {
      // Name the step the run actually died on, from the journal, so the
      // failure points somewhere real instead of at a synthetic index 0.
      const lastStep = await tx
        .select({ stepId: steps.stepId, index: steps.index })
        .from(steps)
        .where(eq(steps.runId, id))
        .orderBy(desc(steps.index))
        .limit(1);

      const last = lastStep[0];

      const result: ReplayResult = {
        status: 'failed',
        stepId: last?.stepId ?? '(no step executed)',
        stepIndex: last?.index ?? 0,
        expected: 'the owning worker to keep heartbeating while it held the session',
        observed: `${SESSION_LOST}: no heartbeat since ${cutoff.toISOString()}; the browser session is gone`,
        evidence: [],
        runId: id,
      };

      const updated = await tx
        .update(runs)
        .set({
          state: 'failed',
          // Control returns to automation: there is no session left for a human
          // to take over, so leaving it `human` would strand it in an operator
          // queue forever.
          control: 'automation',
          finishedAt: new Date(),
          result,
        })
        .where(eq(runs.id, id))
        .returning();

      const row = updated[0];
      if (row) reaped.push(row);
    }

    return reaped;
  });
}
