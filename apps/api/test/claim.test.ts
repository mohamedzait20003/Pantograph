import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';

import { createDb, type DbHandle } from '../src/db/index.js';
import { runs } from '../src/db/schema.js';
import { SESSION_LOST, claimNextRun, heartbeat, reapStaleRuns } from '../src/db/claim.js';

/**
 * These tests need a real Postgres, because what they verify — `FOR UPDATE SKIP
 * LOCKED` under concurrency — has no meaning against a mock. A fake that always
 * returns different rows would pass while proving nothing.
 *
 * So the suite probes for a database and skips cleanly when there isn't one. A
 * reviewer must be able to run `pnpm test` on a laptop with no Docker and see
 * green, not a wall of connection errors that hides a real failure elsewhere.
 */

const TEST_ID_PREFIX = 'r_test_claim_';

let handle: DbHandle | null = null;
let skipReason = '';

const url = process.env.DATABASE_URL;

if (!url) {
  skipReason = 'DATABASE_URL is not set';
} else {
  try {
    const candidate = createDb(url, { max: 4 });
    // Two separate probes: the server answering, and the schema being migrated.
    // They fail for different reasons and deserve different advice.
    await candidate.client`select 1`;
    await candidate.db.select({ id: runs.id }).from(runs).limit(1);
    handle = candidate;
  } catch (error) {
    skipReason = describeError(error);
  }
}

/**
 * Driver connection errors frequently carry an empty `message` and put the
 * useful part in `code` (ECONNREFUSED, 28P01). Falling back to `error.message`
 * alone prints "skipped — ." and tells a reviewer nothing.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error) || 'unknown error';

  const code = (error as { code?: unknown }).code;
  const detail = error.message || error.name || 'unknown error';

  return typeof code === 'string' && code.length > 0 ? `${detail} (${code})` : detail;
}

if (handle === null) {
  console.warn(
    `[claim.test] skipped — ${skipReason}.\n` +
      `  To run these: docker compose up -d db && pnpm db:migrate`,
  );
}

/** Narrows the handle inside tests that only run when it exists. */
function ctx(): DbHandle {
  if (handle === null) throw new Error('database handle unavailable');
  return handle;
}

describe.skipIf(handle === null)('the claim query', () => {
  beforeAll(async () => {
    const { db } = ctx();
    await db.delete(runs).where(like(runs.id, `${TEST_ID_PREFIX}%`));
  });

  afterAll(async () => {
    if (handle === null) return;
    await handle.db.delete(runs).where(like(runs.id, `${TEST_ID_PREFIX}%`));
    await handle.client.end();
  });

  it('never hands the same run to two concurrent workers', async () => {
    const { db } = ctx();
    const first = `${TEST_ID_PREFIX}a`;
    const second = `${TEST_ID_PREFIX}b`;

    await db.insert(runs).values([
      { id: first, mode: 'replay', state: 'queued', capabilityRef: 'corebank.member.savings_balance' },
      { id: second, mode: 'replay', state: 'queued', capabilityRef: 'corebank.member.savings_balance' },
    ]);

    const [one, two] = await Promise.all([
      claimNextRun(db, 'http://localhost:7001'),
      claimNextRun(db, 'http://localhost:7002'),
    ]);

    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(one?.id).not.toBe(two?.id);

    // Each claim pinned its run to the worker that won it.
    expect(one?.workerAddr).not.toBe(two?.workerAddr);
    expect(one?.state).toBe('running');
    expect(one?.claimedAt).toBeInstanceOf(Date);
  });

  it('returns null when the queue is empty rather than blocking', async () => {
    const { db } = ctx();
    await db.delete(runs).where(like(runs.id, `${TEST_ID_PREFIX}%`));

    // Any leftover queued rows in a dev database would be claimed instead, so
    // this asserts the shape of the answer, not that the queue is globally empty.
    const claimed = await claimNextRun(db, 'http://localhost:7001');
    expect(claimed === null || claimed.state === 'running').toBe(true);
  });

  it('reaps a stale run to failed and does not re-queue it', async () => {
    const { db } = ctx();
    const id = `${TEST_ID_PREFIX}stale`;
    const longAgo = new Date(Date.now() - 120_000);

    await db.insert(runs).values({
      id,
      mode: 'replay',
      state: 'running',
      capabilityRef: 'corebank.member.savings_balance',
      workerAddr: 'http://localhost:7009',
      claimedAt: longAgo,
      heartbeatAt: longAgo,
    });

    const reaped = await reapStaleRuns(db, 30_000);
    expect(reaped.some((row) => row.id === id)).toBe(true);

    const after = await db.select().from(runs).where(eq(runs.id, id));
    const row = after[0];

    expect(row?.state).toBe('failed');
    // The whole point: a lost session is terminal, never returned to the queue.
    expect(row?.state).not.toBe('queued');
    expect(row?.finishedAt).toBeInstanceOf(Date);
    expect(row?.result?.status).toBe('failed');
    expect(row?.result?.status === 'failed' && row.result.observed).toContain(SESSION_LOST);
  });

  it('leaves a run with a fresh heartbeat alone', async () => {
    const { db } = ctx();
    const id = `${TEST_ID_PREFIX}healthy`;

    await db.insert(runs).values({
      id,
      mode: 'replay',
      state: 'running',
      workerAddr: 'http://localhost:7001',
      claimedAt: new Date(),
      heartbeatAt: new Date(),
    });

    const reaped = await reapStaleRuns(db, 30_000);
    expect(reaped.some((row) => row.id === id)).toBe(false);

    const after = await db.select().from(runs).where(eq(runs.id, id));
    expect(after[0]?.state).toBe('running');
  });

  it('tells a reaped worker its heartbeat no longer lands', async () => {
    const { db } = ctx();
    const id = `${TEST_ID_PREFIX}beat`;

    await db.insert(runs).values({ id, mode: 'replay', state: 'running', heartbeatAt: new Date() });
    expect(await heartbeat(db, id)).toBe(true);

    // Once the reaper has marked it failed, the worker's next beat misses —
    // which is how it learns to stop driving a session nobody is watching.
    await db.update(runs).set({ state: 'failed' }).where(eq(runs.id, id));
    expect(await heartbeat(db, id)).toBe(false);
  });
});
