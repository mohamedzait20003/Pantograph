import { describe, expect, it } from 'vitest';

import {
  CapabilitySchema,
  LocatorBundleSchema,
  ProvenanceSchema,
  inputsToJsonSchema,
} from '../src/index.js';

import fixture from './fixtures/member-savings-balance.json';

/**
 * The fixture is the reference artifact. Mutating a structural clone of it for
 * the negative cases keeps each test to a single deliberate defect, so a
 * failure points at the rule that broke rather than at an unrelated typo.
 */
function draft(): Record<string, unknown> {
  return structuredClone(fixture) as unknown as Record<string, unknown>;
}

/** Narrow helper so the negative tests can reach into the cloned JSON. */
function stepAt(capability: Record<string, unknown>, index: number): Record<string, unknown> {
  const steps = capability['steps'];
  if (!Array.isArray(steps)) throw new Error('fixture has no steps array');
  return steps[index] as Record<string, unknown>;
}

describe('the hand-written fixture', () => {
  it('round-trips through the schema', () => {
    const result = CapabilitySchema.safeParse(fixture);

    if (!result.success) {
      throw new Error(`fixture failed to parse:\n${JSON.stringify(result.error.issues, null, 2)}`);
    }

    expect(result.data.ref).toBe('corebank.member.savings_balance');
    expect(result.data.outputs['savingsBalance']?.type).toBe('money');
    expect(result.data.app.variant).toBe('a');
  });

  it('declares the survey interstitial as recoverable, not as a failure', () => {
    const capability = CapabilitySchema.parse(fixture);
    const survey = capability.recoverable.find((d) => d.name === 'SURVEY_INTERSTITIAL');

    expect(survey?.match).toEqual({ kind: 'text', value: 'How are we doing?' });
    expect(survey?.handle.kind).toBe('click');
    expect(survey?.maxTimes).toBe(1);
  });

  it('treats a missing member as a terminal business outcome, not a crash', () => {
    const capability = CapabilitySchema.parse(fixture);
    const notFound = capability.businessOutcomes.find((d) => d.name === 'MEMBER_NOT_FOUND');

    expect(notFound?.terminal).toBe(true);
    expect(notFound?.match).toEqual({ kind: 'text', value: 'No member matching that ID.' });
  });

  it('carries a tenant B override for the renamed ID field', () => {
    const capability = CapabilitySchema.parse(fixture);
    const candidates = capability.overrides?.['b']?.['s2']?.target?.candidates ?? [];

    expect(candidates.some((c) => c.by === 'label' && c.label === 'Account Number')).toBe(true);
  });
});

describe('LocatorBundleSchema', () => {
  const sorted = {
    frame: ['content'],
    description: 'the Search button on the search form',
    candidates: [
      { by: 'role', tier: 1, role: 'button', name: 'Search' },
      { by: 'text', tier: 3, text: 'Search' },
    ],
  };

  it('accepts candidates ordered by ascending tier', () => {
    expect(LocatorBundleSchema.safeParse(sorted).success).toBe(true);
  });

  it('accepts equal adjacent tiers (cell and text are both tier 3)', () => {
    const equalTiers = {
      ...sorted,
      candidates: [
        { by: 'cell', tier: 3, row: 'Savings', column: 'Balance' },
        { by: 'text', tier: 3, text: '8,417.32' },
      ],
    };

    expect(LocatorBundleSchema.safeParse(equalTiers).success).toBe(true);
  });

  it('rejects candidates that are not sorted by tier', () => {
    const unsorted = {
      ...sorted,
      candidates: [
        { by: 'text', tier: 3, text: 'Search' },
        { by: 'role', tier: 1, role: 'button', name: 'Search' },
      ],
    };

    const result = LocatorBundleSchema.safeParse(unsorted);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/ascending tier/);
  });

  it('rejects an empty candidate list', () => {
    const result = LocatorBundleSchema.safeParse({ ...sorted, candidates: [] });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/at least one candidate/);
  });

  it('rejects a coordinates candidate that opts out of approval', () => {
    const result = LocatorBundleSchema.safeParse({
      ...sorted,
      candidates: [{ by: 'coordinates', tier: 5, x: 412, y: 388, requiresApproval: false }],
    });

    expect(result.success).toBe(false);
  });
});

describe('capability cross-field validation', () => {
  it('rejects an extract step binding to an undeclared output', () => {
    const capability = draft();
    stepAt(capability, 4)['as'] = 'notDeclaredAnywhere';

    const result = CapabilitySchema.safeParse(capability);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => /not a declared output/.test(i.message))).toBe(true);
  });

  it('rejects a declared output that no step produces', () => {
    const capability = draft();
    const outputs = capability['outputs'] as Record<string, unknown>;
    outputs['checkingBalance'] = { type: 'money', description: 'never extracted' };

    const result = CapabilitySchema.safeParse(capability);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => /no extract step produces it/.test(i.message))).toBe(
      true,
    );
  });

  it('rejects a step interpolating an undeclared input', () => {
    const capability = draft();
    stepAt(capability, 1)['value'] = '{{accountNumber}}';

    const result = CapabilitySchema.safeParse(capability);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => /not a declared input/.test(i.message))).toBe(true);
  });

  it('rejects an override targeting a step that does not exist', () => {
    const capability = draft();
    const overrides = capability['overrides'] as Record<string, Record<string, unknown>>;
    const tenantB = overrides['b'];
    if (!tenantB) throw new Error('fixture lost its tenant B override');
    tenantB['s99'] = { value: 'orphaned' };

    const result = CapabilitySchema.safeParse(capability);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => /unknown step 's99'/.test(i.message))).toBe(true);
  });

  it('rejects duplicate step ids', () => {
    const capability = draft();
    stepAt(capability, 2)['id'] = 's2';

    const result = CapabilitySchema.safeParse(capability);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => /Duplicate step id/.test(i.message))).toBe(true);
  });
});

describe('provenance', () => {
  it('refuses an artifact carrying a model transcript', () => {
    const result = ProvenanceSchema.safeParse({
      recordedAt: '2026-09-08T19:42:11.000Z',
      model: 'claude-opus-5',
      targetUrl: 'http://localhost:4000/',
      runId: 'run_7f3a91c2',
      transcript: [{ role: 'assistant', content: 'clicked Search' }],
    });

    expect(result.success).toBe(false);
  });

  it('refuses an artifact carrying recorded input values', () => {
    const capability = draft();
    const provenance = capability['provenance'] as Record<string, unknown>;
    provenance['inputValues'] = { memberId: '12345' };

    expect(CapabilitySchema.safeParse(capability).success).toBe(false);
  });
});

describe('inputsToJsonSchema', () => {
  it('produces a usable function-calling signature', () => {
    const capability = CapabilitySchema.parse(fixture);
    const schema = inputsToJsonSchema(capability.inputs);

    expect(schema).toMatchObject({
      type: 'object',
      properties: {
        memberId: {
          type: 'string',
          pattern: '^\\d{5}$',
          description: "The member's 5-digit identifier, as printed on their statement.",
        },
      },
      required: ['memberId'],
    });
  });

  it('carries the example through as a JSON Schema example', () => {
    const schema = inputsToJsonSchema(CapabilitySchema.parse(fixture).inputs);
    const properties = (schema as { properties: Record<string, { examples?: unknown[] }> })
      .properties;

    expect(properties['memberId']?.examples).toEqual(['12345']);
  });

  it('omits optional inputs from required', () => {
    const schema = inputsToJsonSchema({
      branch: {
        type: 'enum',
        required: false,
        description: 'Restrict the search to one branch.',
        enum: ['Lafayette Main', 'Kokomo'],
      },
    });

    expect((schema as { required?: string[] }).required).toBeUndefined();
    expect(schema).toMatchObject({
      properties: { branch: { enum: ['Lafayette Main', 'Kokomo'] } },
    });
  });

  it('throws rather than emitting a broken signature for an empty enum', () => {
    expect(() =>
      inputsToJsonSchema({
        branch: { type: 'enum', required: true, description: 'Branch.', enum: [] },
      }),
    ).toThrow(/declares no values/);
  });
});
