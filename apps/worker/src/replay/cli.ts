import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { CapabilitySchema, type Capability, type PolicyConfig, type ReplayResult } from '@pantograph/core';

import { PlaywrightWebSurface } from '../surface/playwright.js';
import { replay } from './engine.js';
import { FilesystemEvidenceStore } from './evidence.js';
import { JsonlJournal } from './journal.js';

/**
 * pnpm replay --cap <ref>@<version> --input name=value [--inject <mode>] [--allow-draft]
 *
 * Exit codes are the contract with whatever calls this:
 *
 *   0  success           - the outputs are in the JSON on stdout
 *   2  business outcome  - the run completed and the answer is "no"
 *   1  hard failure      - the run broke; evidence paths are in the JSON
 *
 * Business outcome gets its own code because a calling system has to treat it
 * differently from a crash. "No member matching that ID" should be surfaced
 * to the user who asked; a broken locator should page an engineer. Folding
 * both into exit 1 forces the caller to parse our output to tell them apart,
 * and the first caller that does not will alert on every not-found.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const CAPABILITIES_DIR = path.join(REPO_ROOT, 'capabilities');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence');

const EXIT_SUCCESS = 0;
const EXIT_HARD_FAILURE = 1;
const EXIT_BUSINESS_OUTCOME = 2;

/**
 * Reads `capabilities/<ref>@<version>.json` and validates it. The database
 * read replaces this function later; nothing else in the CLI changes.
 */
export async function loadCapability(ref: string, version: number): Promise<Capability> {
  const file = path.join(CAPABILITIES_DIR, `${ref}@${version}.json`);
  const raw = await readFile(file, 'utf8');
  return CapabilitySchema.parse(JSON.parse(raw));
}

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    [
      'usage: pnpm replay --cap <ref>@<version> --input name=value [--input ...]',
      '                   [--target <url>] [--inject <failmode>] [--allow-draft]',
      '                   [--confirm <token>] [--variant <id>] [--headless]',
      '',
      'exit codes: 0 success, 2 business outcome, 1 hard failure',
    ].join('\n'),
  );
  process.exit(EXIT_HARD_FAILURE);
}

function parseCapabilityRef(value: string): { ref: string; version: number } {
  const at = value.lastIndexOf('@');
  if (at <= 0) usage(`--cap must look like ref@version, got '${value}'`);
  const version = Number(value.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) usage(`invalid version in '${value}'`);
  return { ref: value.slice(0, at), version };
}

function parseInputs(pairs: string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) usage(`--input must look like name=value, got '${pair}'`);
    inputs[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return inputs;
}

/**
 * Policy is deployment configuration, not artifact content - the artifact
 * says what to do and the policy says where it is allowed to do it. Derived
 * from the target URL here; a real deployment loads it from config.
 */
function policyFor(targetUrl: string): PolicyConfig {
  return {
    allowedHosts: [new URL(targetUrl).host],
    allowedRoutes: ['/', '/search', '/member/:id', '/member/:id/subaccount'],
    allowedActions: ['navigate', 'click', 'type', 'select', 'extract', 'assert'],
    maxSteps: 50,
    timeoutMs: 120_000,
  };
}

function printReadable(result: ReplayResult): void {
  const line = (label: string, value: string): void => console.log(`  ${label.padEnd(10)} ${value}`);

  switch (result.status) {
    case 'success':
      console.log('\nSUCCESS');
      line('run', result.runId);
      line('duration', `${result.durationMs}ms`);
      line('tiers', result.resolutionTiers.join(', ') || '(none)');
      for (const [name, value] of Object.entries(result.outputs)) line(name, value);
      break;

    case 'business_outcome':
      console.log('\nBUSINESS OUTCOME');
      line('run', result.runId);
      line('outcome', result.outcome);
      line('detail', result.detail);
      break;

    case 'failed':
      console.log('\nFAILED');
      line('run', result.runId);
      line('step', `${result.stepId} (index ${result.stepIndex})`);
      line('expected', result.expected);
      line('observed', result.observed);
      for (const file of result.evidence) line('evidence', file);
      break;
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      cap: { type: 'string' },
      input: { type: 'string', multiple: true, default: [] },
      target: { type: 'string', default: process.env.TARGET_URL ?? 'http://localhost:4000' },
      inject: { type: 'string' },
      'allow-draft': { type: 'boolean', default: false },
      confirm: { type: 'string' },
      variant: { type: 'string' },
      headless: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });

  if (values.help || !values.cap) usage(values.help ? undefined : '--cap is required');

  const { ref, version } = parseCapabilityRef(values.cap);
  const inputs = parseInputs(values.input);
  const targetUrl = values.target;

  const capability = await loadCapability(ref, version);

  const evidence = new FilesystemEvidenceStore(EVIDENCE_DIR);
  const runId = `r_${Date.now().toString(36)}`;
  const journal = new JsonlJournal(path.join(evidence.runDir(runId), 'journal.jsonl'));

  console.log(`replaying ${ref}@${version} against ${targetUrl} as ${runId}`);
  if (values.inject) console.log(`injecting ?fail=${values.inject}`);

  const surface = await PlaywrightWebSurface.launch({
    baseUrl: targetUrl,
    ...(values.headless ? { headless: true } : {}),
  });

  let result: ReplayResult;
  try {
    await surface.startTracing();
    result = await replay(
      capability,
      inputs,
      { surface, journal, evidence, policy: policyFor(targetUrl), baseUrl: targetUrl },
      {
        runId,
        allowDraft: values['allow-draft'],
        ...(values.confirm !== undefined ? { confirmationToken: values.confirm } : {}),
        ...(values.variant !== undefined ? { variant: values.variant } : {}),
        ...(values.inject !== undefined ? { navigationParams: { fail: values.inject } } : {}),
      },
    );
  } finally {
    try {
      const trace = await surface.stopTracing();
      const written = await evidence.writeTrace(runId, trace);
      console.log(`trace: ${written}`);
    } catch (error) {
      console.error(`trace not written: ${error instanceof Error ? error.message : String(error)}`);
    }
    await surface.close();
  }

  printReadable(result);
  console.log('\n' + JSON.stringify(result, null, 2));

  switch (result.status) {
    case 'success':
      return EXIT_SUCCESS;
    case 'business_outcome':
      return EXIT_BUSINESS_OUTCOME;
    case 'failed':
      return EXIT_HARD_FAILURE;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(EXIT_HARD_FAILURE);
  },
);
