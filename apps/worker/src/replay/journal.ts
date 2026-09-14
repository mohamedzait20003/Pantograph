import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { redact } from '@pantograph/core';

/**
 * The run journal: append-only, one line per record, JSON per line.
 *
 * This is the primary debugging artifact. When a replay fails at 3am the
 * on-call engineer opens this file, not a database - so it has to be readable
 * with `cat`, greppable by step id, and complete on its own. The database row
 * for the run is a summary; the journal is the record.
 *
 * Every record passes through `redact()` before it is written. The journal
 * sees typed values, extracted text and page descriptions, any of which can
 * carry a member id or an account number, and it lives on disk next to the
 * screenshots. Redacting at the writer rather than at each call site means
 * there is no way to forget.
 */

/** Mirrors the `steps` table so a journal can be loaded into it verbatim. */
export type StepOutcomeKind = 'ok' | 'business_outcome' | 'recoverable' | 'stuck' | 'failed';

export type JournalStepRecord = {
  type: 'step';
  runId: string;
  at: string;
  index: number;
  stepId: string;
  action: string;
  /** Which locator tier matched. Null for steps that resolve nothing. */
  resolutionTier: number | null;
  outcome: StepOutcomeKind;
  detail: string | null;
  latencyMs: number;
  actor: 'automation' | 'human';
};

export type JournalRecord =
  | {
      type: 'open';
      runId: string;
      at: string;
      ref: string;
      version: number;
      /** Input *names* and types only; values never reach the journal. */
      inputShape: Record<string, string>;
    }
  | JournalStepRecord
  | {
      type: 'event';
      runId: string;
      at: string;
      kind:
        | 'preflight_failed'
        | 'policy_denied'
        | 'escalation'
        | 'recoverable'
        | 'business_outcome'
        | 'checkpoint'
        | 'evidence';
      detail: string;
      data?: unknown;
    }
  | { type: 'close'; runId: string; at: string; status: string; durationMs: number };

export interface JournalWriter {
  write(record: JournalRecord): Promise<void>;
}

export class JsonlJournal implements JournalWriter {
  private ready: Promise<void> | null = null;

  constructor(private readonly filePath: string) {}

  async write(record: JournalRecord): Promise<void> {
    this.ready ??= mkdir(path.dirname(this.filePath), { recursive: true }).then(() => undefined);
    await this.ready;
    await appendFile(this.filePath, `${JSON.stringify(redact(record))}\n`, 'utf8');
  }
}

/** For tests and for callers that want the records in-process. Still redacts. */
export class MemoryJournal implements JournalWriter {
  readonly records: JournalRecord[] = [];

  async write(record: JournalRecord): Promise<void> {
    this.records.push(redact(record) as JournalRecord);
  }

  steps(): JournalStepRecord[] {
    return this.records.filter((r): r is JournalStepRecord => r.type === 'step');
  }
}
