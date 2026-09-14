# ADR 004 — The error taxonomy: three branches, not exceptions with codes

**Status:** Accepted
**Date:** 2026-09-13

## Context

A replay of "look up member 99999 and read the Savings balance" can end in
several ways that look superficially alike — the run stops, no balance comes
back — and are nothing alike in what should happen next:

- The system said *No member matching that ID.* The automation worked
  perfectly. The answer to the question is "there is no such member", and the
  agent that asked needs to hear exactly that.
- A survey interstitial appeared in front of the search form. Nothing is
  wrong; something is in the way. Dismiss it and carry on.
- The session expired, or the vendor renamed the Member ID field, or the
  network dropped. The run cannot complete, and a person needs to look.

The conventional shape for this is an exception hierarchy or a result with an
`error` field and a code. Both make the three cases the same *kind* of thing,
distinguished by a value the caller has to remember to inspect. That is the
single most common design mistake in this problem, and it is a mistake with a
specific consequence on a bank system: a not-found becomes a failure, failures
get retried, retries page engineers, and the actual signal — that the member
does not exist — is lost under a stack of identical stack traces. Worse, the
first caller that treats every non-success as "retry it" will happily retry a
run that has already submitted a form.

## Decision

`ReplayResult` is a discriminated union of three shapes, and the engine can
only return one of them:

```
{ status: 'success',          outputs, runId, durationMs, resolutionTiers }
{ status: 'business_outcome', outcome, detail, runId }
{ status: 'failed',           stepId, stepIndex, expected, observed, evidence, runId }
```

A caller cannot read `outputs` without having first proved `status ===
'success'`, and cannot mistake a business outcome for a failure, because they
are different shapes rather than different values of one field. The type
checker enforces the distinction the exception hierarchy left to discipline.

The three branches correspond to three kinds of detector in the artifact, and
the engine evaluates them in a fixed order before every step and on every
checkpoint poll:

**Business outcomes first.** A `BusinessOutcomeDetector` names a legitimate
result — `MEMBER_NOT_FOUND`, `PERMISSION_DENIED` — by the exact text the
system renders when it delivers that result. When one matches, the run ends
*successfully* with `business_outcome`. It is not thrown, not logged as a
failure, not retried, and the journal row says `business_outcome`. The
detector's `terminal: true` is a literal, not a boolean: a business outcome
always ends the run, because that is what makes it an outcome rather than an
obstacle. This is the single most important behaviour in the engine, and it is
the first thing tested.

**Recoverable conditions second.** A `RecoverableDetector` names a transient
obstacle and exactly what to do about it, from a closed set of three actions:
click a target, wait a bounded number of milliseconds, or reload. The engine
applies the handle, counts the attempt against the detector's `maxTimes`, and
re-evaluates the screen from the top — because dismissing an interstitial may
reveal a business outcome underneath it. Exceeding `maxTimes` converts the
condition into a hard failure.

**Everything else is a hard failure.** There is deliberately no
`HardFailureDetector` type. A hard failure is defined by *exhaustion* — nothing
matched a business outcome, nothing matched a recoverable condition, and the
step could not resolve or the checkpoint did not pass — not by recognition.
Giving it a detector would imply the artifact author can enumerate the ways a
legacy system breaks, and it would invite classifying an unknown screen as a
known failure, which is how a replay reports a confident wrong answer. The
absence of the type is the design.

### What the caller does differently

| Result             | Exit code | Caller's move                                                                |
| ------------------ | --------- | ---------------------------------------------------------------------------- |
| `success`          | 0         | Consume `outputs`. Watch `resolutionTiers` for drift.                        |
| `business_outcome` | 2         | Surface `outcome` and `detail` to whoever asked. Do not retry; do not alert. |
| `failed`           | 1         | Open the evidence. Page a person. Do not retry blindly.                      |

Business outcome gets its own exit code so a shell caller can tell "the answer
is no" from "the run broke" without parsing JSON. The first caller that could
not tell them apart would alert on every not-found.

Two supporting properties of `failed` matter as much as the branch itself. The
result carries `expected` and `observed` as human-readable prose — "the Member
ID input on the search form to be resolvable" against "tried 3 strategies: tier
1 role (no match) ...; screen showing cell 'Your session has expired.', button
'Sign In'" — plus the screenshot that was taken at the moment of failure. A
failure that only said `TimeoutError` would be a failure nobody could act on at
3am. And a locator that resolved at a lower tier than recorded reports what the
higher tiers saw, so a rising tier is a diagnosis and not just a symptom.

### Why recovery is bounded and declared, not inferred

Recovery could have been left to the engine to work out: notice something
unexpected, look for a button that says Dismiss or Close or OK, click it, hope.
That is what a model would do during discovery, and it is exactly what must
not happen during replay, for three reasons.

It is not deterministic. The premise of replay is that the same artifact
against the same screens does the same thing every time. An engine that
improvises a recovery does something different depending on what it noticed,
and the run is no longer reproducible or reviewable.

It is unbounded. A recovery loop with no declared limit is an infinite loop
with good intentions: it burns the run's time budget re-dismissing a dialog
that reappears, and it buries the real problem — why does the dialog keep
coming back? — under a stack of identical successes. `maxTimes` is the
artifact author saying, in the pull request, how many times this condition is
plausible. One survey per session is plausible. Five is a sign something else
is wrong, and a clean failure at that point is worth more than a sixth attempt.

It is unreviewable and potentially unsafe. A recovery handle is a closed union
of click, wait and reload because a handle that could express arbitrary
behaviour is a second automation engine hiding inside the error handler —
invisible to the reviewer who approved the steps, and able to mutate state
while nominally "recovering". Declaring the handle in the artifact puts it in
the same diff as everything else the reviewer signed off on.

## Consequences

**What this buys us.** A calling agent gets an honest answer to "did it work,
and if not, why" in a form the type system will not let it misread. Read-only
capabilities run unattended and report not-found as data. Failures arrive
with a screenshot, the step that broke, and what was on screen instead of what
was expected, which is the difference between a five-minute fix and a
half-day. And because both business outcomes and recoveries are declared in
the artifact, the reviewer who approves a capability has seen every result it
can produce and every obstacle it will clear on its own.

**What it costs.** Detectors are string matches on exact copy. If the vendor
rewords "No member matching that ID." to "Member not found", the business
outcome stops matching and the run degrades to a hard failure at the next
step — a *loud* degradation with the new text in `observed`, which is the
correct failure mode, but a degradation. The copy strings are therefore
treated as a public API of the target: centralised, tested, and changed
deliberately.

The engine cannot classify what it has not been told about. A new business
outcome the artifact does not declare — say the vendor adds a "member is
deceased" screen — is a hard failure until someone adds the detector. That is
deliberate: the alternative is the engine guessing, and a guess that lands on
"success" is the worst outcome available. Discovery is where new outcomes are
learned; replay is where declared ones are executed.

Finally, ordering is load-bearing and easy to get wrong when this code is
next touched. Business outcomes are checked before recoverable conditions so
that a not-found page with a survey on top ends the run one action sooner and
never lets a recovery handle interact with a page that has already given its
answer. Detectors are not evaluated before a `navigate` step, because a
navigate discards the current screen — and before the first one, that screen
is whatever the previous run left in the browser. The first version of the
engine got this wrong and reported the previous caller's not-found as the next
caller's answer; the test suite caught it within one run, which is the
argument for running these tests against the real target rather than a mock.
