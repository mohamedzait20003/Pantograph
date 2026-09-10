import { describe, expect, it } from 'vitest';

import {
  checkAction,
  checkNavigation,
  classifyRisk,
  explainRisk,
  matchRoute,
  redact,
  redactString,
  type PolicyConfig,
  type Step,
} from '../src/index.js';

const config: PolicyConfig = {
  allowedHosts: ['localhost:4000'],
  allowedRoutes: ['/', '/search', '/member/:id', '/member/:id/subaccount'],
  allowedActions: ['navigate', 'click', 'type', 'select', 'extract', 'assert'],
  maxSteps: 40,
  timeoutMs: 30_000,
};

/** A click on a control, with the accessible name the locator aims at. */
function clickStep(name: string, risk: Step['risk'] = 'confirm'): Step {
  return {
    id: 'c1',
    action: 'click',
    risk,
    target: {
      frame: ['content'],
      description: `the ${name} button`,
      candidates: [{ by: 'role', tier: 1, role: 'button', name }],
    },
  };
}

describe('checkNavigation', () => {
  it('allows an allowlisted host on a matching route', () => {
    expect(checkNavigation('http://localhost:4000/member/12345', config)).toEqual({
      allowed: true,
    });
  });

  it('rejects a host that is not on the allowlist', () => {
    const decision = checkNavigation('http://evil.example/search', config);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/not in the allowlist/);
  });

  it('rejects a subdomain of an allowed host — there are no wildcards', () => {
    const hostConfig: PolicyConfig = { ...config, allowedHosts: ['bank.example'] };

    expect(checkNavigation('https://evil.bank.example/search', hostConfig).allowed).toBe(false);
  });

  it('rejects a path matching no pattern', () => {
    const decision = checkNavigation('http://localhost:4000/admin/export', config);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/does not match any allowed route/);
  });

  it('rejects a non-http scheme', () => {
    expect(checkNavigation('javascript:alert(1)', config).allowed).toBe(false);
    expect(checkNavigation('file:///etc/passwd', config).allowed).toBe(false);
  });

  it('rejects a relative URL when no base is supplied, rather than assuming a host', () => {
    expect(checkNavigation('/search', config).allowed).toBe(false);
  });

  it('resolves a relative URL against a supplied base', () => {
    expect(checkNavigation('/search', config, 'http://localhost:4000').allowed).toBe(true);
    expect(checkNavigation('/search', config, 'http://evil.example').allowed).toBe(false);
  });

  it('redacts account-shaped numbers out of the reason string', () => {
    const decision = checkNavigation('http://localhost:4000/admin/123456789012', config);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toContain('[REDACTED:NUM]');
    expect(decision.allowed === false && decision.reason).not.toContain('123456789012');
  });
});

describe('matchRoute', () => {
  it('matches a :param segment against a concrete value', () => {
    expect(matchRoute('/member/:id', '/member/12345')).toBe(true);
  });

  it('does not let a :param swallow extra segments', () => {
    expect(matchRoute('/member/:id', '/member/12345/subaccount')).toBe(false);
  });

  it('matches the root pattern', () => {
    expect(matchRoute('/', '/')).toBe(true);
  });

  it('does not match a different literal segment', () => {
    expect(matchRoute('/member/:id', '/account/12345')).toBe(false);
  });
});

describe('checkAction', () => {
  it('rejects an action outside the allowed set', () => {
    const readOnly: PolicyConfig = { ...config, allowedActions: ['navigate', 'extract', 'assert'] };
    const decision = checkAction(clickStep('Search'), readOnly);

    expect(decision.allowed).toBe(false);
    expect(decision.allowed === false && decision.reason).toMatch(/'click' is not permitted/);
  });

  it('checks the destination of a navigate step, not just the verb', () => {
    const step: Step = { id: 'n1', action: 'navigate', risk: 'safe', url: 'http://evil.example/' };

    expect(checkAction(step, config).allowed).toBe(false);
  });

  it('allows an in-policy action', () => {
    expect(checkAction(clickStep('Search'), config)).toEqual({ allowed: true });
  });
});

describe('classifyRisk', () => {
  it('treats reads and movement as safe', () => {
    const navigate: Step = { id: 'n1', action: 'navigate', risk: 'safe', url: '/search' };
    const assert: Step = {
      id: 'a1',
      action: 'assert',
      risk: 'safe',
      check: { match: { kind: 'text', value: 'Member Detail' }, description: 'arrived', timeoutMs: 5000 },
    };

    expect(classifyRisk(navigate)).toBe('safe');
    expect(classifyRisk(assert)).toBe('safe');
  });

  it('classifies a form-submitting click as confirm', () => {
    expect(classifyRisk(clickStep('Submit Application'))).toBe('confirm');
    expect(explainRisk(clickStep('Submit Application')).reason).toMatch(/state-changing/);
  });

  it('classifies any click inside a POST form as confirm', () => {
    const decision = explainRisk(clickStep('Continue'), { insidePostForm: true });

    expect(decision.risk).toBe('confirm');
    expect(decision.reason).toMatch(/POSTs/);
  });

  it('classifies an unrecognized action as confirm, not safe', () => {
    // An artifact written against a newer schema than this build understands.
    const unknown = { id: 'x1', action: 'wire_transfer', risk: 'safe' } as unknown as Step;

    expect(classifyRisk(unknown)).toBe('confirm');
    expect(explainRisk(unknown).reason).toMatch(/Unrecognized action/);
  });

  it('honours a configured deny list over the artifact', () => {
    expect(classifyRisk(clickStep('Submit Application', 'safe'), { denyList: ['Submit Application'] })).toBe(
      'blocked',
    );
    expect(classifyRisk(clickStep('Search', 'safe'), { denyList: ['c1'] })).toBe('blocked');
  });

  it('never downgrades a step the artifact marks blocked', () => {
    expect(classifyRisk(clickStep('Search', 'blocked'))).toBe('blocked');
  });
});

describe('redaction', () => {
  it('redacts a nested password key by name', () => {
    const redacted = redact({
      session: { user: 'teller01', password: 'hunter2', nested: { apiKey: 'sk-live-abc' } },
    }) as { session: { user: string; password: string; nested: { apiKey: string } } };

    expect(redacted.session.password).toBe('[REDACTED:KEY]');
    expect(redacted.session.nested.apiKey).toBe('[REDACTED:KEY]');
    // Non-sensitive siblings survive, or the log becomes useless.
    expect(redacted.session.user).toBe('teller01');
  });

  it('redacts a 16-digit run', () => {
    expect(redactString('card 4111111111111111 on file')).toBe('card [REDACTED:NUM] on file');
  });

  it('redacts an email address', () => {
    expect(redactString('contact r.okonkwo@bank.example today')).toBe(
      'contact [REDACTED:EMAIL] today',
    );
  });

  it('redacts an SSN-shaped string', () => {
    expect(redactString('ssn 123-45-6789')).toBe('ssn [REDACTED:SSN]');
  });

  it('does not mangle a money string', () => {
    expect(redactString('8,417.63')).toBe('8,417.63');
    expect(redactString('Balance: 15,980.04')).toBe('Balance: 15,980.04');
  });

  it('does not mangle a generated reference number', () => {
    expect(redactString('SA-12345-482910')).toBe('SA-12345-482910');
  });

  it('redacts inside arrays and leaves ordinary numbers alone', () => {
    const redacted = redact({ balances: ['1,204.55', 4111111111111111], count: 3 }) as {
      balances: unknown[];
      count: number;
    };

    expect(redacted.balances[0]).toBe('1,204.55');
    expect(redacted.balances[1]).toBe('[REDACTED:NUM]');
    expect(redacted.count).toBe(3);
  });

  it('is stable across repeated calls', () => {
    // Guards the /g regex lastIndex trap: a global regex reused with .test()
    // returns alternating answers on identical input.
    for (let i = 0; i < 4; i += 1) {
      expect(redact(4111111111111111)).toBe('[REDACTED:NUM]');
      expect(redactString('acct 4111111111111111')).toBe('acct [REDACTED:NUM]');
    }
  });

  it('survives a cyclic structure', () => {
    const cyclic: Record<string, unknown> = { name: 'run' };
    cyclic['self'] = cyclic;

    expect(() => redact(cyclic)).not.toThrow();
  });

  it('does not mutate its input', () => {
    const original = { password: 'hunter2' };
    redact(original);

    expect(original.password).toBe('hunter2');
  });
});
