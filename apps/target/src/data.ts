import { randomInt } from 'node:crypto';

export type AccountRow = {
  type: string;
  number: string;
  balance: string;
};

export type Member = {
  id: string;
  name: string;
  status: 'ACTIVE' | 'DORMANT' | 'CLOSED';
  accounts: AccountRow[];
};

/**
 * Discriminated union rather than `Member | null`, because "not found" and
 * "not authorized" are different UI states with different copy, and the
 * caller must be forced to handle both.
 */
export type MemberLookup =
  | { kind: 'found'; member: Member }
  | { kind: 'not_found' }
  | { kind: 'denied' };

export const SUBACCOUNT_TYPES = [
  'Savings',
  'Money Market',
  'Certificate',
  'Holiday Club',
] as const;

export type SubaccountType = (typeof SUBACCOUNT_TYPES)[number];

/**
 * Exact user-visible copy.
 *
 * These strings become literal detectors in the artifact schema later, so
 * they live in exactly one place and the views read them from here. Changing
 * a value here is a breaking change for every recorded artifact that asserts
 * on it — treat these as a public API.
 */
export const COPY = {
  NOT_FOUND: 'No member matching that ID.',
  DENIED: 'You are not authorized to view this member.',
  SESSION_EXPIRED: 'Your session has expired.',
  INTERSTITIAL: 'How are we doing?',
  APP_ERROR: 'An unexpected system error occurred. Reference SYS-500.',
  SUBACCOUNT_CREATED: 'Sub-account created successfully.',
} as const;

/**
 * `12345` is the happy path. It carries three account rows on purpose: every
 * cell in the grid is a number, so "read the Savings balance" cannot be
 * solved by grabbing the first number on the page. It requires anchoring on
 * the `Savings` row header and the `Balance` column header.
 */
const MEMBERS: Record<string, Member> = {
  '12345': {
    id: '12345',
    name: 'R. Okonkwo',
    status: 'ACTIVE',
    accounts: [
      { type: 'Checking', number: '0041-887-2', balance: '1,204.55' },
      { type: 'Savings', number: '0041-887-9', balance: '8,417.32' },
      { type: 'Money Market', number: '0041-887-4', balance: '15,980.04' },
    ],
  },
  '23456': {
    id: '23456',
    name: 'M. Haugen',
    status: 'ACTIVE',
    accounts: [
      { type: 'Checking', number: '0072-115-1', balance: '2,145.00' },
      { type: 'Savings', number: '0072-115-8', balance: '19,004.12' },
    ],
  },
  '34567': {
    id: '34567',
    name: 'P. Silveira',
    status: 'DORMANT',
    accounts: [{ type: 'Checking', number: '0088-430-3', balance: '0.00' }],
  },
};

/** `77777` exists in the core but is flagged; the UI must refuse it. */
const RESTRICTED_IDS = new Set(['77777']);

export function lookupMember(id: string): MemberLookup {
  if (RESTRICTED_IDS.has(id))
    return { kind: 'denied' };

  const member = MEMBERS[id];

  if (!member)
    return { kind: 'not_found' };
  
  return { kind: 'found', member };
}

/**
 * Reference numbers are a runtime output: the whole point is that a replay
 * has to *extract* this value off the confirmation screen rather than
 * predict it, so it is deliberately not derivable from the inputs.
 */
export function createReference(memberId: string): string {
  const serial = String(randomInt(100_000, 1_000_000));
  return `SA-${memberId}-${serial}`;
}
