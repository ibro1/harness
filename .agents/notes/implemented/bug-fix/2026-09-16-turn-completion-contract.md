# Agent Note: A turn that promises to report back has to be able to

Status: implemented

English | [中文](2026-09-16-turn-completion-contract.zh.md)

## Problem

A deployed agent was asked to clone a repository and answered:

> I am fetching the latest changes from the repository `SilPix/distressers` into `/workspace/distressers` right now. I'll update you as soon as it finishes.

Then it stopped. Nothing was running, no notice could arrive, and the operator waited a day before asking again. The answer, when it finally came, was that the repository returns HTTP 404 — a fact available in the second the clone would have taken.

The clone failing is ordinary. The cost was entirely in the sentence: a promise of a future message that the turn had no way to send.

## Decision

The prompt registry serves a harness-owned section, `harness:turn-contract`, immediately after the identity line and ahead of any deployment persona:

> Finish what you start within the turn that starts it. A turn ends when you stop writing, and anything you described but did not do stops with it.
>
> Deferring is only real when something will tell you the work finished. Without that, run the operation now and report what happened, however long it takes. Never say you will report back on work that is not running.

Harness-owned rather than persona text, for the same reason the identity line is: a deployment that writes its own persona should not have to remember to re-state a behavioural invariant, and one that forgets should not silently lose it. `includeTurnContract` turns it off for a loop that genuinely can resume an unfinished turn.

**It deliberately does not say background work is impossible**, because in this harness it is not: `ctx.jobs` really does notify a model when a job settles, and `tool:jobs` already tells it so. A rule contradicting a live tool teaches a model to discount one of them. The distinction drawn is between deferring *to* something and merely saying you will.

## Alternatives considered

**Put it in the deployment persona.** Where the failing deployment's own instructions live, and the shortest change. Rejected because it makes a harness invariant optional by omission: every new persona would have to remember it.

**Give the agent-loop a way to resume an unfinished turn.** Addresses the promise by making it keepable. Far larger, and the wrong order — a mechanism for deferred completion is worth building when something needs it, not to rescue a sentence the model should not have written.

**Say nothing and let `tool:jobs` cover it.** That section explains how jobs report; it cannot govern a turn that started no job. The gap is precisely the case where no mechanism is involved.

## Consequences

- Every assembled prompt carries roughly 55 more words. Small and permanent, against a failure that cost a day.
- Model-visible text moved, so 17 `system-prompt.expected.md` snapshots changed with it.
- Two suites the change does not touch, `snapshots/acp` and `snapshots/sdk`, are **flaky in this environment** — repeated runs of an unchanged tree produced 10 then 14 failures, in files that carry no prompt text and were not modified. They are worth stabilising on their own; they are not evidence about this change either way.
