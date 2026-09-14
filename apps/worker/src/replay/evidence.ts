import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { redactString } from '@pantograph/core';

/**
 * Evidence: screenshots on every hard failure and escalation, and the trace
 * for the run.
 *
 * Written behind an interface so the storage can change without touching a
 * call site. Today this is a directory per run; in production it becomes S3
 * keys under the same layout, and the `evidence` table keeps pointing at
 * strings either way. The engine never learns which.
 *
 * Labels become filenames, so they are drawn from a fixed vocabulary - step
 * ids and event kinds - and never from input values. A member id in a
 * filename is a member id in every directory listing, backup, and log line
 * that ever mentions the file. `redactString` runs on the label regardless, as
 * a backstop against a step id that happens to look like an account number.
 */

export interface EvidenceStore {
  /** Returns the path or key the screenshot was written to. */
  writeScreenshot(runId: string, label: string, bytes: Uint8Array): Promise<string>;
  writeTrace(runId: string, bytes: Uint8Array): Promise<string>;
}

export class FilesystemEvidenceStore implements EvidenceStore {
  private readonly sequence = new Map<string, number>();

  constructor(private readonly rootDir: string) {}

  /** `evidence/<runId>/` - also where the JSONL journal for the run belongs. */
  runDir(runId: string): string {
    return path.join(this.rootDir, safeSegment(runId));
  }

  async writeScreenshot(runId: string, label: string, bytes: Uint8Array): Promise<string> {
    const next = (this.sequence.get(runId) ?? 0) + 1;
    this.sequence.set(runId, next);

    const file = path.join(
      this.runDir(runId),
      `${String(next).padStart(3, '0')}-${safeSegment(label)}.jpg`,
    );
    await this.persist(file, bytes);
    return file;
  }

  async writeTrace(runId: string, bytes: Uint8Array): Promise<string> {
    const file = path.join(this.runDir(runId), 'trace.zip');
    await this.persist(file, bytes);
    return file;
  }

  private async persist(file: string, bytes: Uint8Array): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

/** Redacts, then keeps only characters that are safe in every filesystem. */
function safeSegment(value: string): string {
  return redactString(value).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80) || 'unnamed';
}
