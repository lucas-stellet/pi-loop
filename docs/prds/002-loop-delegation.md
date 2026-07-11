# PRD 002: Loop Delegation and Background Execution

## Problem Statement

A loop supervisor cannot complete meaningful coding objectives unless it can delegate work to capable executors. The user wants the main agent to avoid direct execution, but still autonomously complete tasks that may require repository scouting, implementation, tests, reviews, and nit fixes. Existing subagent and chain patterns provide useful primitives, but loop mode needs a constrained delegation contract that records evidence and prevents uncontrolled recursion.

## Solution

Add loop-specific delegation tools that the supervisor can use to launch background subagents, chains, or generated teams. These tools are wrappers around Pi's existing subagent and chain/workflow capabilities, but they add loop-aware constraints: run association, artifact capture, timeout and retry policy, evidence requirements, and recursion limits.

Delegated agents perform the actual repository reads, code edits, command execution, tests, and reviews. The loop runtime records child lifecycle and result facts as typed events associated with both the parent loop run and child run. A deterministic projector turns those events and full child artifacts into a concise evidence context. The supervisor uses that context to decide the next delegation step; human-readable markdown may summarize the decision but is not the authoritative evidence store.

## User Stories

1. As a supervisor agent, I want to delegate scouting to a specialist, so that I can understand the task without reading arbitrary project files myself.
2. As a supervisor agent, I want to delegate implementation to a worker or chain, so that code changes are made outside the control plane.
3. As a supervisor agent, I want to delegate verification to reviewers or testers, so that completion is based on independent evidence.
4. As a user, I want delegated work to run in the background, so that long tasks do not block the main session unnecessarily.
5. As a user, I want each delegation to produce structured evidence, so that I can audit why the loop continued or completed.
6. As a user, I want the supervisor to choose between a single subagent and a chain based on task complexity, so that simple fixes do not require heavyweight orchestration.
7. As a user, I want the supervisor to create a team when the objective has multiple independent sub-issues, so that work can be parallelized when safe.
8. As a maintainer, I want delegation depth to be limited, so that subagents cannot recursively spawn unbounded work.
9. As a maintainer, I want delegation failures to be classified, so that retryable failures can be retried and non-retryable failures stop the loop honestly.
10. As a user, I want blocked workers to contact the supervisor only for real blockers, so that the loop remains autonomous but does not invent product decisions.

## Implementation Decisions

- Expose loop-specific delegation tools instead of giving the supervisor raw access to all execution tools.
- Delegation tools must associate every child run with the active loop run.
- A delegation can target a single agent, a named chain, or a generated team/workflow depending on the objective and available primitives.
- Child agents may receive normal coding tools according to their role; the supervisor remains restricted.
- Child agents should not receive loop supervisor tools by default.
- Delegation depth must be bounded. The default should permit supervisor-to-worker delegation but prevent unbounded nested orchestration.
- Delegation prompts must require evidence: files changed, commands run, tests run, review findings, remaining nits, confidence, and blockers.
- The host records observable child facts as typed events, including child identity, lifecycle status, artifact references, command outcomes, changed-file scope, findings, blockers, and result classification.
- Child prose is preserved as an artifact but does not by itself establish lifecycle or validation facts.
- Delegation events must be consumable by the loop journal projector without requiring the supervisor to scan raw child output or JSONL.
- Retry policy applies to failed delegations rather than to arbitrary supervisor turns.
- Retry decisions should distinguish provider interruptions, timeouts, authentication failures, tool failures, test failures, and genuine task blockers.
- The supervisor can use a single subagent for narrow tasks and a chain/team for multi-step or multi-context objectives.
- Results should be summarized for the supervisor while preserving full artifacts for later inspection.

## Testing Decisions

- Tests should verify that the supervisor can launch only approved delegation modes.
- Tests should verify that delegated runs are associated with the active loop run.
- Tests should verify recursion limits.
- Tests should verify timeout and retry behavior for retryable failures.
- Tests should verify non-retryable failures stop or pause the loop rather than causing endless retries.
- Tests should verify evidence extraction from child results.
- Tests should include a narrow single-agent task and a multi-step chain task.
- Tests should avoid asserting exact model prose; assert structured fields and state transitions instead.

## Out of Scope

- Full dynamic JavaScript workflow runtime implementation if an existing Pi workflow extension can be reused.
- Cross-repository distributed execution.
- Automatic pull request creation.
- Operating-system sandboxing for child agents.
- Sophisticated parallel worktree merge and conflict resolution.

## Further Notes

This PRD assumes the supervisor is already restricted by loop mode. Its purpose is to define how the supervisor gets real work done without directly becoming an executor.
