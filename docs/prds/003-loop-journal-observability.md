# PRD 003: Loop Journal, State, and Observability

## Problem Statement

Autonomous loops are hard to trust and debug without durable state and a clear event trail. If the system continues across multiple supervisor turns and delegated subagent runs, users and maintainers need to understand what happened, what evidence was produced, why the supervisor continued, and why it eventually completed, paused, or failed.

Chat history alone is not enough. It can be compacted, become noisy, or omit low-level lifecycle details. The loop needs a durable operational record.

## Solution

Add a loop journal and state model that records every important loop event before surfacing it to the UI or supervisor. The journal provides an append-only event stream, a current state snapshot, and human-readable markdown summaries. The supervisor uses markdown control files for planning and decision-making, while the runtime uses structured state and event records for recovery, status, and auditing.

## User Stories

1. As a user, I want to see the current loop status, so that I know whether the objective is planning, delegating, evaluating, paused, failed, or complete.
2. As a user, I want to inspect delegated work, so that I can understand which agents ran and what they produced.
3. As a user, I want every continuation decision to be recorded, so that I can see why the loop kept going.
4. As a user, I want every completion decision to include evidence, so that I can trust the final result.
5. As a maintainer, I want an append-only event log, so that crashes or reloads do not erase what already happened.
6. As a maintainer, I want a state snapshot, so that status commands can load the latest loop state quickly.
7. As a maintainer, I want lifecycle events to be typed and versioned, so that future UI and tooling can consume them safely.
8. As a user, I want markdown summaries, so that I can review loop progress without parsing JSON.
9. As a user, I want compact status in the TUI/statusline, so that autonomous work remains visible without overwhelming the session.
10. As a maintainer, I want recovery after session reload or compaction, so that active loops do not lose their state.

## Implementation Decisions

- Use an explicit event envelope with schema version, run identity, monotonically increasing sequence, timestamp, event kind, and payload.
- Persist events before publishing UI updates or supervisor-visible summaries.
- Maintain both structured runtime state and human-readable markdown control summaries.
- Separate user-editable or supervisor-editable control artifacts from runtime-managed state artifacts.
- Define event kinds for loop lifecycle, supervisor decisions, delegations, retries, guardrail violations, budget updates, nits, evidence, completion, pause, resume, and failure.
- Provide status and result tools or commands that read the structured state rather than scraping chat output.
- Keep full child artifacts available but return concise summaries to the supervisor to avoid context blowup.
- Record token usage, duration, attempts, and result classification per delegation.
- Preserve active loop state across reload and compaction.
- Treat journal writes as part of the safety model: if the journal cannot be written, the loop should fail closed rather than continue invisibly.

## Testing Decisions

- Tests should verify event sequence monotonicity and append-only behavior.
- Tests should verify that each lifecycle transition writes the expected event kind.
- Tests should verify that status is reconstructed from persisted state after reload.
- Tests should verify that delegated run summaries link back to full artifacts.
- Tests should verify that guardrail violations are recorded before being returned to the supervisor.
- Tests should verify that journal write failures stop the loop safely.
- Tests should verify compaction/reload recovery for active, paused, failed, and complete states.
- Tests should assert event shapes and state transitions, not exact display formatting.

## Out of Scope

- External hosted dashboard.
- Long-term analytics across all projects.
- Full SQLite-backed query API in the first version if JSONL and snapshots are enough.
- Distributed multi-machine event streaming.
- Permanent archival policy.

## Further Notes

Compozy's append-before-publish journal pattern is a strong reference. For the MVP, the simplest durable event log plus state snapshot is acceptable, as long as recovery and auditability are designed from the start.
