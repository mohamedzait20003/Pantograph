/**
 * THE REPLAY ENGINE. THERE IS NO LLM IN THIS FILE, AND THERE MUST NEVER BE ONE.
 *
 * This is the production execution path. An AI agent may *trigger* a replay,
 * and an LLM *discovered* the flow that became the artifact, but nothing in
 * here consults a model. Every decision is made by the artifact, the policy
 * config, and what is actually on screen. That is what makes the run
 * deterministic, auditable, and cheap - and it is what lets a bank sign off on
 * running it unattended.
 *
 * Two things carry the weight here. Determinism: the same artifact and the
 * same inputs against the same screens do the same thing, every time. And the
 * error taxonomy: a legitimate business result is never reported as a crash.
 * "No member matching that ID" is an answer, not an error, and the caller
 * needs it as one. See docs/adr/004-error-taxonomy.md.
 */

import { randomBytes } from 'node:crypto';

import {
  checkAction,
  checkNavigation,
  classifyRisk,
  redactString,
  type BusinessOutcomeDetector,
  type Capability,
  type Checkpoint,
  type InputSpec,
  type LocatorBundle,
  type Match,
  type PolicyConfig,
  type RecoverableDetector,
  type ReplayResult,
  type Resolution,
  type Step,
  type Surface,
  type SurfaceNode,
  type SurfaceSnapshot,
} from '@pantograph/core';

import type { EvidenceStore } from './evidence.js';
import type { JournalRecord, JournalWriter, StepOutcomeKind } from './journal.js';

/**
 * A journal record minus the fields the run fills in. Distributive over the
 * union - a plain `Omit` would collapse it to the keys every variant shares.
 */
type JournalDraft = JournalRecord extends infer R
  ? R extends JournalRecord
    ? Omit<R, 'runId' | 'at'>
    : never
  : never;

export type ReplayDeps = {
  surface: Surface;
  journal: JournalWriter;
  evidence: EvidenceStore;
  policy: PolicyConfig;
  /** Resolves relative navigate locations for the policy check. */
  baseUrl: string;
};

export type ReplayOptions = {
  runId?: string;
  /**
   * A `draft` capability has not been reviewed. Unattended replay against a
   * bank system should require a reviewed artifact, so drafts are refused
   * unless the caller says, explicitly and per run, that they know.
   */
  allowDraft?: boolean;
  /**
   * Presence means a human has taken responsibility for this run's
   * `confirm`-risk steps. Its value is opaque here; the API that issued it
   * is what ties it to a person.
   */
  confirmationToken?: string;
  /**
   * Extra query parameters appended to every navigation. Exists so the CLI's
   * `--inject` can reach the target's `?fail=` conditions through the same
   * entry URL a real run uses, without the artifact knowing about them.
   */
  navigationParams?: Record<string, string>;
  /** Apply this variant's overrides from the artifact, if any. */
  variant?: string;
  /** Operator deny list, consulted by risk classification. */
  denyList?: string[];
};

const POLL_INTERVAL_MS = 100;
const PREFLIGHT_STEP_ID = 'preflight';

export async function replay(
  artifact: Capability,
  inputs: Record<string, unknown>,
  deps: ReplayDeps,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const run = new ReplayRun(artifact, deps, options);
  return run.execute(inputs);
}

/** Internal verdict of a pre-step gate. `null` means proceed. */
type Verdict = ReplayResult | null;

class ReplayRun {
  private readonly runId: string;
  private readonly startedAt = Date.now();
  private readonly resolutionTiers: number[] = [];
  private readonly outputs: Record<string, string> = {};
  private readonly evidencePaths: string[] = [];
  private readonly recoveryCounts = new Map<string, number>();
  private values: Record<string, string> = {};

  constructor(
    private readonly artifact: Capability,
    private readonly deps: ReplayDeps,
    private readonly options: ReplayOptions,
  ) {
    this.runId = options.runId ?? `r_${randomBytes(4).toString('hex')}`;
  }

  async execute(rawInputs: Record<string, unknown>): Promise<ReplayResult> {
    await this.journal({
      type: 'open',
      ref: this.artifact.ref,
      version: this.artifact.version,
      inputShape: Object.fromEntries(
        Object.entries(this.artifact.inputs).map(([name, spec]) => [name, spec.type]),
      ),
    });

    const preflight = await this.preflight(rawInputs);
    if (preflight) return this.close(preflight);

    for (const [index, recorded] of this.artifact.steps.entries()) {
      const step = this.interpolate(this.applyOverride(recorded));

      const budget = this.checkBudget(step, index);
      if (budget) return this.close(budget);

      const gate = await this.gate(step, index);
      if (gate) return this.close(gate);

      // Detectors evaluate the screen this flow produced. A navigate discards
      // whatever is on screen, so nothing about it can be an outcome of this
      // run - and before the first navigate it is a leftover from the previous
      // run in the same browser. Checking it would report the last caller's
      // not-found page as this caller's answer.
      if (step.action !== 'navigate') {
        const detectors = await this.checkDetectors(step, index);
        if (detectors) return this.close(detectors);
      }

      const outcome = await this.perform(step, index);
      if (outcome) return this.close(outcome);
    }

    const final = await this.finalCheckpoint();
    if (final) return this.close(final);

    const missing = Object.keys(this.artifact.outputs).filter((name) => !(name in this.outputs));
    if (missing.length > 0) {
      // The caller's contract said it would get these. A silent `undefined`
      // would be reported as success and consumed as data.
      const last = this.artifact.steps.length - 1;
      return this.close(
        await this.fail(this.artifact.steps[last]?.id ?? 'outputs', last, {
          expected: `declared outputs to be extracted: ${missing.join(', ')}`,
          observed: `no extract step produced ${missing.join(', ')}`,
        }),
      );
    }

    return this.close({
      status: 'success',
      outputs: this.outputs,
      runId: this.runId,
      durationMs: Date.now() - this.startedAt,
      resolutionTiers: this.resolutionTiers,
    });
  }

  // ---------------------------------------------------------------------------
  // Before the first step
  // ---------------------------------------------------------------------------

  private async preflight(rawInputs: Record<string, unknown>): Promise<Verdict> {
    if (this.artifact.approval !== 'approved' && this.options.allowDraft !== true) {
      return this.preflightFailure(
        'an approved capability, or an explicit allowDraft for this run',
        `capability '${this.artifact.ref}@${this.artifact.version}' has approval '${this.artifact.approval}'`,
      );
    }

    if (this.artifact.steps.length > this.deps.policy.maxSteps) {
      return this.preflightFailure(
        `at most ${this.deps.policy.maxSteps} steps under this policy`,
        `${this.artifact.steps.length} steps`,
      );
    }

    // Inputs are validated before any browser action. A mismatch here is a
    // caller error and should be reported as one - precisely which parameter
    // and why - not discovered halfway through a flow that has already typed
    // into a live system.
    const validated = validateInputs(this.artifact.inputs, rawInputs);
    if (!validated.ok) return this.preflightFailure(validated.expected, validated.observed);
    this.values = validated.values;

    const entry = checkNavigation(this.deps.baseUrl, this.deps.policy);
    if (!entry.allowed) {
      return this.preflightFailure('an entry URL inside the policy allowlist', entry.reason);
    }

    return null;
  }

  private async preflightFailure(expected: string, observed: string): Promise<ReplayResult> {
    await this.journal({ type: 'event', kind: 'preflight_failed', detail: `${expected} | ${observed}` });
    // No step ran, so there is no real step to point at. `preflight` at index
    // 0 is the convention the CLI and the journal both understand.
    return {
      status: 'failed',
      stepId: PREFLIGHT_STEP_ID,
      stepIndex: 0,
      expected,
      observed,
      evidence: [],
      runId: this.runId,
    };
  }

  // ---------------------------------------------------------------------------
  // Per-step gates
  // ---------------------------------------------------------------------------

  private checkBudget(step: Step, index: number): Verdict {
    const elapsed = Date.now() - this.startedAt;
    if (elapsed <= this.deps.policy.timeoutMs) return null;
    return this.failSync(step.id, index, {
      expected: `the run to finish within ${this.deps.policy.timeoutMs}ms`,
      observed: `${elapsed}ms elapsed before step ${step.id}`,
    });
  }

  private async gate(step: Step, index: number): Promise<Verdict> {
    const decision = checkAction(step, this.deps.policy, this.deps.baseUrl);
    if (!decision.allowed) {
      await this.journal({ type: 'event', kind: 'policy_denied', detail: decision.reason });
      return this.fail(step.id, index, {
        expected: `step ${step.id} to be permitted by policy`,
        observed: decision.reason,
      });
    }

    // Risk. The artifact's own `risk` is the human-reviewed value and it
    // governs; the classifier can only escalate it to `blocked` via the deny
    // list, never relax it. Using the classifier alone would mark every click
    // and every keystroke `confirm`, and a read-only capability could never
    // run unattended - which would defeat the point of recording it.
    const denyList = this.options.denyList ?? [];
    const classified = classifyRisk(step, denyList.length > 0 ? { denyList } : {});
    const effective = classified === 'blocked' ? 'blocked' : step.risk;

    if (effective === 'blocked') {
      return this.fail(step.id, index, {
        expected: `step ${step.id} to be executable`,
        observed: 'the step is blocked by the artifact or the operator deny list',
      });
    }

    if (effective === 'confirm' && this.options.confirmationToken === undefined) {
      // Stop and escalate. An irreversible step running unattended with no
      // human accountable for it is the single failure mode this system most
      // needs to avoid; a stalled run is recoverable, a wrong sub-account is
      // not. The next stage turns this into a paused run and an intervention
      // record; for now it is a hard stop with the evidence a person needs.
      await this.journal({
        type: 'event',
        kind: 'escalation',
        detail: `step ${step.id} is confirm-risk and no confirmation token was supplied`,
      });
      return this.fail(
        step.id,
        index,
        {
          expected: `a confirmation token before executing confirm-risk step ${step.id}`,
          observed: 'no confirmation token supplied; run halted before acting',
        },
        { outcome: 'stuck', label: `escalation-${step.id}` },
      );
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Detectors - the load-bearing ordering
  // ---------------------------------------------------------------------------

  /**
   * Business outcomes first, recoverable conditions second, then proceed.
   *
   * Order matters. If the survey interstitial and a not-found message were
   * both on screen, dismissing the survey first would then find not-found and
   * still end correctly - but checking not-found first ends the run one
   * action sooner and never risks a recovery handle interacting with a page
   * that has already given its answer.
   */
  private async checkDetectors(step: Step, index: number): Promise<Verdict> {
    // Bounded by construction: each recoverable detector caps its own
    // attempts, so this loop can run at most sum(maxTimes) + 1 times.
    for (;;) {
      const snapshot = await this.deps.surface.observe();

      for (const detector of this.artifact.businessOutcomes) {
        if (await this.matches(detector.match, snapshot)) {
          return this.businessOutcome(detector, step, index);
        }
      }

      const recoverable = await this.firstRecoverable(snapshot);
      if (recoverable === null) return null;

      const attempts = (this.recoveryCounts.get(recoverable.name) ?? 0) + 1;
      if (attempts > recoverable.maxTimes) {
        // An unbounded recovery loop is worse than a clean failure: it burns
        // the run's time budget and buries the real problem under a stack of
        // identical dismissals. The declared bound is the artifact author
        // saying how many times this condition is plausible.
        return this.fail(step.id, index, {
          expected: `'${recoverable.name}' to clear within ${recoverable.maxTimes} attempt(s)`,
          observed: `'${recoverable.name}' still matched after ${recoverable.maxTimes} recovery attempt(s)`,
        });
      }
      this.recoveryCounts.set(recoverable.name, attempts);

      await this.journal({
        type: 'event',
        kind: 'recoverable',
        detail: `${recoverable.name} attempt ${attempts}/${recoverable.maxTimes}`,
      });
      await this.journalStep(step, index, {
        outcome: 'recoverable',
        detail: `${recoverable.name} handled by ${recoverable.handle.kind}`,
        tier: null,
        latencyMs: 0,
      });

      const handled = await this.applyRecovery(recoverable, step, index);
      if (handled) return handled;
      // Re-observe: the recovery may have revealed a business outcome, or the
      // same condition may be back, in which case the counter catches it.
    }
  }

  private async firstRecoverable(snapshot: SurfaceSnapshot): Promise<RecoverableDetector | null> {
    for (const detector of this.artifact.recoverable) {
      if (await this.matches(detector.match, snapshot)) return detector;
    }
    return null;
  }

  private async applyRecovery(
    detector: RecoverableDetector,
    step: Step,
    index: number,
  ): Promise<Verdict> {
    const { handle } = detector;

    switch (handle.kind) {
      case 'click': {
        const resolved = await this.deps.surface.resolve(handle.target);
        if (!resolved.found) {
          return this.fail(step.id, index, {
            expected: `${handle.target.description} to be resolvable for recovery '${detector.name}'`,
            observed: describeAttempts(resolved.attempted),
          });
        }
        await this.deps.surface.act({ kind: 'click', handle: resolved.handle });
        return null;
      }

      case 'wait':
        // A declared, bounded pause the artifact author chose for a specific
        // condition - not an implicit sleep in the step path. It is capped by
        // the schema and counted against maxTimes like any other recovery.
        await new Promise<void>((resolve) => setTimeout(resolve, handle.ms));
        return null;

      case 'reload':
        await this.deps.surface.act({
          kind: 'navigate',
          location: await this.deps.surface.currentLocation(),
        });
        return null;
    }
  }

  private async businessOutcome(
    detector: BusinessOutcomeDetector,
    step: Step,
    index: number,
  ): Promise<ReplayResult> {
    // This is a successful end of the run. Not a failure, not a retry, not a
    // throw. The journal row says so, the result says so, and the caller gets
    // the answer it asked for.
    await this.journalStep(step, index, {
      outcome: 'business_outcome',
      detail: detector.name,
      tier: null,
      latencyMs: 0,
    });
    await this.journal({ type: 'event', kind: 'business_outcome', detail: detector.name });

    return {
      status: 'business_outcome',
      outcome: detector.name,
      detail: detector.detail,
      runId: this.runId,
    };
  }

  // ---------------------------------------------------------------------------
  // Acting
  // ---------------------------------------------------------------------------

  private async perform(step: Step, index: number): Promise<Verdict> {
    const started = Date.now();
    const latency = (): number => Date.now() - started;

    switch (step.action) {
      case 'navigate': {
        const location = this.withNavigationParams(step.url);
        await this.deps.surface.act({ kind: 'navigate', location });
        await this.journalStep(step, index, { outcome: 'ok', detail: null, tier: null, latencyMs: latency() });
        return null;
      }

      case 'assert': {
        const met = await this.awaitCheckpoint(step.check, step, index);
        if (met) return met;
        await this.journalStep(step, index, {
          outcome: 'ok',
          detail: step.check.description,
          tier: null,
          latencyMs: latency(),
        });
        return null;
      }

      case 'click':
      case 'type':
      case 'select':
      case 'extract': {
        const resolved = await this.deps.surface.resolve(step.target);
        if (!resolved.found) {
          return this.fail(step.id, index, {
            expected: `${step.target.description} to be resolvable`,
            observed: await this.describeMiss(resolved, step.target),
          });
        }

        // The tier that matched is the drift signal. Recorded per step so a
        // capability quietly sliding from tier 1 to tier 4 shows up in the
        // telemetry long before the tier 4 candidate breaks too.
        this.resolutionTiers.push(resolved.tier);

        await this.executeResolved(step, resolved.handle);

        // When a lower tier caught it, say what the higher tiers saw. That is
        // the difference between "drift" and a diagnosis someone can act on.
        const detail = resolutionDetail(step, resolved.attempted);

        await this.journalStep(step, index, {
          outcome: 'ok',
          detail,
          tier: resolved.tier,
          latencyMs: latency(),
        });
        return null;
      }
    }
  }

  private async executeResolved(step: Step, handle: unknown): Promise<void> {
    switch (step.action) {
      case 'click':
        await this.deps.surface.act({ kind: 'click', handle });
        return;
      case 'type':
        await this.deps.surface.act({ kind: 'type', handle, text: step.value });
        return;
      case 'select':
        await this.deps.surface.act({ kind: 'select', handle, value: step.value });
        return;
      case 'extract': {
        const { text } = await this.deps.surface.act({ kind: 'readText', handle });
        this.outputs[step.as] = text ?? '';
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Checkpoints
  // ---------------------------------------------------------------------------

  private async finalCheckpoint(): Promise<Verdict> {
    const last = this.artifact.steps.length - 1;
    const step = this.artifact.steps[last];

    if (!step)
      return null;

    const met = await this.awaitCheckpoint(this.artifact.checkpoint, step, last);
    if (met)
      return met;
    
    await this.journal({ type: 'event', kind: 'checkpoint', detail: this.artifact.checkpoint.description });
    return null;
  }

  /**
   * Polls until the checkpoint matches or its timeout elapses. Detectors are
   * re-checked on every poll, because the screen that appears while we wait
   * may be the not-found page - which is an answer, not a failed checkpoint.
   */
  private async awaitCheckpoint(checkpoint: Checkpoint, step: Step, index: number): Promise<Verdict> {
    const deadline = Date.now() + checkpoint.timeoutMs;

    for (;;) {
      const detectors = await this.checkDetectors(step, index);
      if (detectors) return detectors;

      const snapshot = await this.deps.surface.observe();
      if (await this.matches(checkpoint.match, snapshot)) return null;

      if (Date.now() >= deadline) {
        return this.fail(step.id, index, {
          expected: checkpoint.description,
          observed: describeScreen(snapshot),
        });
      }

      // A poll interval on a condition, not a sleep: the loop exits the
      // moment the checkpoint matches.
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  private async matches(match: Match, snapshot: SurfaceSnapshot): Promise<boolean> {
    switch (match.kind) {
      case 'text':
        return snapshotContainsText(snapshot, match.value);
      case 'urlPattern':
        return new RegExp(match.value).test(snapshot.location);
      case 'absent': {
        const resolved = await this.deps.surface.resolve(match.target);
        return !resolved.found;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Failure, journal, close
  // ---------------------------------------------------------------------------

  private async fail(
    stepId: string,
    stepIndex: number,
    detail: { expected: string; observed: string },
    options: { outcome?: StepOutcomeKind; label?: string } = {},
  ): Promise<ReplayResult> {
    const outcome = options.outcome ?? 'failed';
    const label = options.label ?? `failure-${stepId}`;

    // Evidence on every hard failure and every escalation: the screenshot is
    // what turns "expected X, observed Y" into something a person can act on.
    try {
      const bytes = await this.deps.surface.screenshot();
      const written = await this.deps.evidence.writeScreenshot(this.runId, label, bytes);
      this.evidencePaths.push(written);
      await this.journal({ type: 'event', kind: 'evidence', detail: written });
    } catch (error) {
      await this.journal({
        type: 'event',
        kind: 'evidence',
        detail: `screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    await this.journalStep(
      { id: stepId } as Step,
      stepIndex,
      { outcome, detail: `${detail.expected} | ${detail.observed}`, tier: null, latencyMs: 0 },
      this.artifact.steps[stepIndex]?.action ?? 'unknown',
    );

    return {
      status: 'failed',
      stepId,
      stepIndex,
      expected: redactString(detail.expected),
      observed: redactString(detail.observed),
      evidence: [...this.evidencePaths],
      runId: this.runId,
    };
  }

  /** For the one gate that runs before any async work and cannot screenshot. */
  private failSync(stepId: string, stepIndex: number, detail: { expected: string; observed: string }): ReplayResult {
    return {
      status: 'failed',
      stepId,
      stepIndex,
      expected: redactString(detail.expected),
      observed: redactString(detail.observed),
      evidence: [...this.evidencePaths],
      runId: this.runId,
    };
  }

  private async describeMiss(
    resolution: Resolution & { found: false },
    bundle: LocatorBundle,
  ): Promise<string> {
    const snapshot = await this.deps.surface.observe();
    return `${describeAttempts(resolution.attempted)}; ${describeScreen(snapshot, { frame: bundle.frame })}`;
  }

  private async journalStep(
    step: Step,
    index: number,
    fields: { outcome: StepOutcomeKind; detail: string | null; tier: number | null; latencyMs: number },
    action: string = step.action,
  ): Promise<void> {
    await this.journal({
      type: 'step',
      index,
      stepId: step.id,
      action,
      resolutionTier: fields.tier,
      outcome: fields.outcome,
      detail: fields.detail,
      latencyMs: fields.latencyMs,
      actor: 'automation',
    });
  }

  private async journal(record: JournalDraft): Promise<void> {
    await this.deps.journal.write({
      ...record,
      runId: this.runId,
      at: new Date().toISOString(),
    } as JournalRecord);
  }

  private async close(result: ReplayResult): Promise<ReplayResult> {
    await this.journal({
      type: 'close',
      status: result.status,
      durationMs: Date.now() - this.startedAt,
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Step shaping
  // ---------------------------------------------------------------------------

  private applyOverride(step: Step): Step {
    const variant = this.options.variant;
    if (variant === undefined) return step;
    const override = this.artifact.overrides?.[variant]?.[step.id];
    if (!override) return step;

    // Only locator and value fields can be overridden; the step list and the
    // actions in it are what a reviewer approved. See artifact.ts.
    const next: Step = { ...step };
    if (override.target !== undefined && 'target' in next) next.target = override.target;
    if (override.value !== undefined && 'value' in next) next.value = override.value;
    if (override.url !== undefined && next.action === 'navigate') next.url = override.url;
    return next;
  }

  private interpolate(step: Step): Step {
    switch (step.action) {
      case 'navigate':
        return { ...step, url: interpolate(step.url, this.values) };
      case 'type':
      case 'select':
        return { ...step, value: interpolate(step.value, this.values) };
      default:
        return step;
    }
  }

  private withNavigationParams(location: string): string {
    const params = this.options.navigationParams;
    if (!params || Object.keys(params).length === 0) return location;

    const url = new URL(location, this.deps.baseUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    // Hand back the same shape we were given: relative stays relative.
    return location.startsWith('http') ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
  }
}

// -----------------------------------------------------------------------------
// Pure helpers
// -----------------------------------------------------------------------------

const PARAM = /\{\{\s*([a-zA-Z]\w*)\s*\}\}/g;

function resolutionDetail(
  step: Step,
  attempted: { tier: number; by: string; detail: string }[],
): string | null {
  const parts = step.action === 'extract' ? [`extracted ${step.as}`] : [];
  if (attempted.length > 0) {
    const attempts = attempted.map((a) => `tier ${a.tier} ${a.by} (${a.detail})`).join('; ');
    parts.push(`fell through: ${attempts}`);
  }
  return parts.length > 0 ? parts.join(' | ') : null;
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(PARAM, (_, name: string) => values[name] ?? '');
}

type ValidatedInputs =
  | { ok: true; values: Record<string, string> }
  | { ok: false; expected: string; observed: string };

/**
 * Validates caller inputs against the declared specs and normalizes them to
 * strings for interpolation.
 *
 * Failure messages describe the *shape* of what was received - its type and
 * length - never the value. An invalid input is still an input someone typed
 * about a real customer, and the failure message ends up in a log.
 */
function validateInputs(
  specs: Record<string, InputSpec>,
  raw: Record<string, unknown>,
): ValidatedInputs {
  const values: Record<string, string> = {};

  for (const name of Object.keys(raw)) {
    if (!(name in specs)) {
      return {
        ok: false,
        expected: `only declared inputs (${Object.keys(specs).join(', ') || 'none'})`,
        observed: `undeclared input '${name}'`,
      };
    }
  }

  for (const [name, spec] of Object.entries(specs)) {
    const value = raw[name];

    if (value === undefined || value === null) {
      if (spec.required) {
        return { ok: false, expected: `required input '${name}' (${spec.type})`, observed: 'not provided' };
      }
      continue;
    }

    const result = validateInput(name, spec, value);
    if (!result.ok) return result;
    values[name] = result.value;
  }

  return { ok: true, values };
}

type InputValidation =
  | { ok: true; value: string }
  | { ok: false; expected: string; observed: string };

function validateInput(name: string, spec: InputSpec, value: unknown): InputValidation {
  const shape = describeShape(value);

  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string') {
        return { ok: false, expected: `input '${name}' to be a string`, observed: shape };
      }
      if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) {
        return {
          ok: false,
          expected: `input '${name}' to match ${spec.pattern}`,
          observed: `${shape} that does not match`,
        };
      }
      return { ok: true, value };
    case 'number': {
      const asNumber = typeof value === 'number' ? value : Number(value);
      if (typeof value === 'boolean' || Number.isNaN(asNumber)) {
        return { ok: false, expected: `input '${name}' to be a number`, observed: shape };
      }
      return { ok: true, value: String(asNumber) };
    }
    case 'boolean':
      if (value !== true && value !== false && value !== 'true' && value !== 'false') {
        return { ok: false, expected: `input '${name}' to be a boolean`, observed: shape };
      }
      return { ok: true, value: String(value) };
    case 'enum': {
      const allowed = spec.enum ?? [];
      if (typeof value !== 'string' || !allowed.includes(value)) {
        return {
          ok: false,
          expected: `input '${name}' to be one of ${allowed.join(', ')}`,
          observed: `${shape} not in the allowed set`,
        };
      }
      return { ok: true, value };
    }
  }
}

function describeShape(value: unknown): string {
  if (typeof value === 'string') return `a string of length ${value.length}`;
  if (Array.isArray(value)) return `an array of length ${value.length}`;
  return `a ${typeof value}`;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function snapshotContainsText(snapshot: SurfaceSnapshot, needle: string): boolean {
  const wanted = normalizeText(needle);
  const visit = (node: SurfaceNode): boolean => {
    if (normalizeText(node.name).includes(wanted)) return true;
    if (node.value !== undefined && normalizeText(node.value).includes(wanted)) return true;
    return node.children.some(visit);
  };
  return snapshot.roots.some(visit);
}

function describeAttempts(attempted: { tier: number; by: string; detail: string }[]): string {
  return `tried ${attempted.length} strateg${attempted.length === 1 ? 'y' : 'ies'}: ${attempted
    .map((a) => `tier ${a.tier} ${a.by} (${a.detail})`)
    .join('; ')}`;
}

/** Roles worth naming even when they have named children. */
const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'heading']);

/**
 * A compact description of what is on screen, for `observed`.
 *
 * Leaves and interactive controls only. On a table-layout page every row and
 * cell is a node whose name is just its children's text concatenated, so
 * listing containers would spend the whole cap on `row "MAIN MENU", cell
 * "MAIN MENU"` from the nav frame and never reach the error message in the
 * content frame. When a frame is given, only that frame is described - a
 * locator that missed was looking somewhere specific, and that is where the
 * answer is. Redacted, because a failure report must be debuggable without
 * becoming a transcript of a customer's account page.
 */
function describeScreen(
  snapshot: SurfaceSnapshot,
  options: { frame?: string[]; limit?: number } = {},
): string {
  const limit = options.limit ?? 24;
  const frameKey = options.frame?.join('/');
  const seen: string[] = [];

  const push = (entry: string): void => {
    if (seen.length < limit && !seen.includes(entry)) seen.push(entry);
  };

  const visit = (node: SurfaceNode): void => {
    if (seen.length >= limit) return;

    const inScope = frameKey === undefined || node.frame.join('/') === frameKey;
    const name = normalizeText(node.name);
    const hasNamedChild = node.children.some((child) => normalizeText(child.name).length > 0);

    if (inScope && name.length > 0) {
      if (node.role === 'text') push(`"${name}"`);
      else if (INTERACTIVE_ROLES.has(node.role) || !hasNamedChild) push(`${node.role} "${name}"`);
    }

    node.children.forEach(visit);
  };
  snapshot.roots.forEach(visit);

  const where = frameKey !== undefined && frameKey.length > 0 ? ` in frame ${frameKey}` : '';
  return redactString(
    `screen at ${snapshot.location}${where} showing ${seen.join(', ') || 'nothing informative'}`,
  );
}

export { validateInputs, interpolate as interpolateTemplate, snapshotContainsText, describeScreen };
