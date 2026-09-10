import { z } from 'zod';
import type { Step, RiskClass } from './step.js';

export const ActionKindSchema = z.enum([
  'navigate',
  'click',
  'type',
  'select',
  'extract',
  'assert',
]);

export type ActionKind = z.infer<typeof ActionKindSchema>;

export const PolicyConfigSchema = z.object({
  allowedHosts: z.array(z.string().min(1)),
  allowedRoutes: z.array(z.string().min(1)),
  allowedActions: z.array(ActionKindSchema),
  maxSteps: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

/**
 * Deliberately not `boolean`. A caller cannot accidentally treat a denial as a
 * pass, and a denial always carries a reason that can go straight into the run
 * journal.
 */
export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

const ALLOW: PolicyDecision = { allowed: true };

/** Every reason string is redacted, so it is safe to log verbatim. */
function deny(reason: string): PolicyDecision {
  return { allowed: false, reason: redactString(reason) };
}

/** Only these schemes can reach a page. `javascript:`, `data:`, `file:` cannot. */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Matches a path against a pattern where a `:name` segment matches exactly one
 * non-empty segment. No wildcards and no partial-prefix matching: `/member/:id`
 * must not authorise `/member/12345/subaccount`, which is a different screen
 * with different consequences.
 */
export function matchRoute(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/').filter((segment) => segment.length > 0);
  const pathSegments = path.split('/').filter((segment) => segment.length > 0);

  if (patternSegments.length !== pathSegments.length) return false;

  for (let i = 0; i < patternSegments.length; i += 1) {
    const expected = patternSegments[i];
    const actual = pathSegments[i];

    if (expected === undefined || actual === undefined)
      return false;

    if (expected.startsWith(':'))
      continue;

    if (expected !== actual)
      return false;
  }

  return true;
}

/**
 * Checks a navigation before it happens.
 *
 * `baseUrl` resolves relative URLs — a recorded step may say `/member/{{id}}`,
 * and the host it resolves against is runtime state the policy engine
 * deliberately does not hold on its own. Without a base, a relative URL is
 * rejected rather than assumed safe: we cannot check a host we do not know.
 */
export function checkNavigation(
  url: string,
  config: PolicyConfig,
  baseUrl?: string,
): PolicyDecision {
  let parsed: URL;
  try {
    parsed = baseUrl === undefined ? new URL(url) : new URL(url, baseUrl);
  } catch {
    return deny(
      `Navigation target is not an absolute URL and no base URL was supplied: ${url}`,
    );
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return deny(`Protocol '${parsed.protocol}' is not permitted; only http and https are.`);
  }

  const host = parsed.host.toLowerCase();
  const allowed = config.allowedHosts.some((candidate) => candidate.toLowerCase() === host);
  if (!allowed) {
    return deny(`Host '${host}' is not in the allowlist.`);
  }

  if (!config.allowedRoutes.some((pattern) => matchRoute(pattern, parsed.pathname))) {
    return deny(`Path '${parsed.pathname}' does not match any allowed route pattern.`);
  }

  return ALLOW;
}

/**
 * Checks an action before it executes.
 *
 * This is the allowlist gate only. The caller must *also* consult
 * `classifyRisk` — an action can be perfectly within the allowlist and still
 * require human confirmation because of what it does.
 */
export function checkAction(
  step: Step,
  config: PolicyConfig,
  baseUrl?: string,
): PolicyDecision {
  if (!config.allowedActions.includes(step.action)) {
    return deny(`Action '${step.action}' is not permitted by this policy.`);
  }

  if (step.action === 'navigate') {
    return checkNavigation(step.url, config, baseUrl);
  }

  return ALLOW;
}

/** Runtime context the surface adapter supplies; the Step alone cannot know it. */
export type RiskContext = {
  denyList?: string[];
  insidePostForm?: boolean;
};

/** Verbs that mean "this writes something" when they lead an accessible name. */
const MUTATING_NAME = /^(submit|create|open|transfer|delete|remove|approve|post|confirm|pay|send)\b/i;

/** The accessible name a click/type/select step is aiming at, if it has one. */
function targetName(step: Step): string | null {
  if (!('target' in step))
    return null;

  for (const candidate of step.target.candidates) {
    if (candidate.by === 'role')
      return candidate.name;

    if (candidate.by === 'label')
      return candidate.label;

    if (candidate.by === 'text')
      return candidate.text;
  }

  return null;
}

/**
 * Classifies what a step can do to the target system.
 *
 * Relationship to the artifact's own `risk` field, which matters: this function
 * is the *classifier*, used at discovery time when no human has looked at the
 * step yet. The `risk` recorded on a Step is the *reviewed* value, and at
 * replay time the reviewed value is what governs — that is the entire point of
 * review. The one thing review cannot do is downgrade a `blocked`, which is why
 * an explicit block and the deny list are checked first here.
 */
export function classifyRisk(step: Step, context: RiskContext = {}): RiskClass {
  return explainRisk(step, context).risk;
}

/**
 * The same classification, with the evidence that produced it.
 *
 * The reason is not decoration. When replay pauses on a `confirm`, the operator
 * is being asked to take responsibility for an irreversible action, and "this
 * control is inside a POST form" is the difference between an informed decision
 * and rubber-stamping a dialog. It is also what lands in the intervention
 * record, so the approval is auditable after the fact.
 */
export function explainRisk(
  step: Step,
  context: RiskContext = {},
): { risk: RiskClass; reason: string } {
  const name = targetName(step);

  // The operator's deny list outranks everything, including the artifact.
  if (context.denyList && context.denyList.length > 0) {
    const denied = context.denyList.some(
      (entry) => entry === step.id || (name !== null && entry === name),
    );
    if (denied) {
      return { risk: 'blocked', reason: 'Target is on the configured deny list.' };
    }
  }

  // A step a reviewer explicitly blocked is never quietly re-enabled.
  if (step.risk === 'blocked') {
    return { risk: 'blocked', reason: 'The recorded artifact marks this step as blocked.' };
  }

  switch (step.action) {
    case 'navigate':
    case 'extract':
    case 'assert':
      return { 
        risk: 'safe',
        reason: `'${step.action}' reads or moves; it changes no state.` 
      };

    case 'click':
    case 'type':
    case 'select': {
      if (context.insidePostForm === true) {
        return { risk: 'confirm', reason: 'The target control is inside a form that POSTs.' };
      }

      if (name !== null && MUTATING_NAME.test(name)) {
        return { risk: 'confirm', reason: `'${redactString(name)}' names a state-changing action.` };
      }

      return {
        risk: 'confirm',
        reason: `'${step.action}' can reach a form, and nothing proves this one does not.`,
      };
    }

    default:
      return {
        risk: 'confirm',
        reason: 'Unrecognized action; treated as consequential by default.',
      };
  }
}

/**
 * Redaction.
 *
 * This runs on everything headed for an artifact, a log line, a run record, or
 * an evidence file. It is the last line of defence rather than the only one:
 * the artifact must never carry recorded input values at all — only the
 * parameter *shape* (name, type, pattern, description). A capability describes
 * how to look up a member; it does not remember which member was looked up.
 *
 * Replacements are fixed-width tags. Never a hash, never a length-preserving
 * mask, never the last four digits: each of those leaks enough to narrow a
 * search, and a hash of a 9-digit number is trivially reversible by brute
 * force. A redacted value carries exactly one bit of information — that
 * something was there.
 */
export const REDACTION_TAGS = {
  key: '[REDACTED:KEY]',
  num: '[REDACTED:NUM]',
  ssn: '[REDACTED:SSN]',
  email: '[REDACTED:EMAIL]',
} as const;

/**
 * Key names whose *value* is a credential regardless of shape. Matched
 * case-insensitively as a substring, so `apiKey`, `API_KEY` and
 * `x-authorization` all hit. Note `auth` is not on its own here — it would
 * redact `author`.
 */
const SENSITIVE_KEY = /(password|passwd|secret|token|api[-_ ]?key|authorization|credential|cvv|ssn|pin)/i;

/**
 * Every quantifier is bounded, and the domain is repeated `label.` groups
 * rather than `[A-Za-z0-9.-]+\.` — in the latter the `.` belongs to both the
 * character class and the delimiter, an ambiguity that backtracks
 * super-linearly. Redaction runs over untrusted page content, so the cost of a
 * regex here is an availability concern, not a style one.
 *
 * The bounds are the real ones: 64-character local part, 63-character DNS
 * label, at most 8 labels. Anything outside them is not a deliverable address,
 * so the limits cost no recall.
 */
const EMAIL = /[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Nine or more *consecutive* digits: account and card numbers. The consecutive
 * requirement is what keeps money safe — `8,417.63` has runs of 1, 3 and 2, and
 * a reference like `SA-12345-482910` has runs of 5 and 6, so neither is touched.
 * Formatted values have to survive redaction intact or every extracted balance
 * in the system becomes `[REDACTED:NUM]`.
 */
const LONG_DIGIT_RUN = /\d{9,}/g;

/**
 * Non-global twin of the above, for `.test()`. A `/g` regex carries `lastIndex`
 * across calls, so testing with it returns alternating answers on the same
 * input — a genuinely nasty bug to have in a redaction path.
 */
const HAS_LONG_DIGIT_RUN = /\d{9,}/;

export function redactString(value: string): string {
  return value.replace(EMAIL, REDACTION_TAGS.email).replace(SSN, REDACTION_TAGS.ssn).replace(LONG_DIGIT_RUN, REDACTION_TAGS.num);
}

/**
 * Deep-walks a value, redacting by key name and by value shape.
 *
 * Returns a new structure; the input is never mutated, because callers pass
 * live objects they still intend to use.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, new WeakSet());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactString(value);

  if (typeof value === 'number') {
    const asText = String(value);
    return HAS_LONG_DIGIT_RUN.test(asText) ? REDACTION_TAGS.num : value;
  }

  if (value === null || typeof value !== 'object')
    return value;

  if (seen.has(value))
    return '[REDACTED:CYCLE]';

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, seen));
  }

  if (value instanceof Date) return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key) ? REDACTION_TAGS.key : redactValue(entry, seen);
  }
  
  return output;
}
