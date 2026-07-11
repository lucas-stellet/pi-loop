# PRD 003: Loop Journal, State, and Observability

## Problem Statement

Autonomous loops are hard to trust and debug without durable state and a clear event trail. If the system continues across multiple supervisor turns and delegated subagent runs, users and maintainers need to understand what happened, what evidence was produced, why the supervisor continued, and why it eventually completed, paused, or failed.

Chat history alone is not enough. It can be compacted, become noisy, or omit low-level lifecycle details. The loop needs a durable operational record.

## Solution

Add a loop journal and state model that records every important loop event before surfacing it to the UI or supervisor. Each run has a runtime-managed JSONL event stream, a current state snapshot, and human-readable markdown summaries. A deterministic projector reduces the raw event stream into a compact supervisor decision context grouped by requirements, delegations, validations, reviews, changes, blockers, and unresolved facts. The projector answers what happened; the supervisor retains the semantic judgment of whether that evidence satisfies the objective. Markdown control files remain useful for planning and explanation, while structured events and projections drive recovery, status, provenance validation, and auditing.

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
- Persist each run's canonical event stream as runtime-managed JSONL with a single serialized writer; repair or reject a partial trailing record during recovery.
- Persist events before publishing UI updates or supervisor-visible summaries, and durably synchronize settlement events before exposing terminal state.
- Maintain both structured runtime state and human-readable markdown control summaries.
- Separate user-editable or supervisor-editable control artifacts from runtime-managed state artifacts. The supervisor cannot directly forge runtime fact or settlement events.
- Define event kinds for loop lifecycle, supervisor decisions, delegations, retries, guardrail violations, budget updates, nits, evidence, completion, pause, resume, and failure.
- Build deterministic projections from events for current state and supervisor context. Projections identify observable facts, missing data, stale references, contradictions, and unresolved blockers without deciding semantic objective completion.
- Inject the compact projection into supervisor turns so the model evaluates relevant context rather than scanning raw JSONL or child logs.
- Record the supervisor's requirement assessments and evidence references as events. The completion tool validates assessment shape and event provenance before appending the terminal completion event.
- Provide status and result tools or commands that read projections and structured state rather than scraping chat output.
- Keep full child artifacts available but return concise projected summaries to the supervisor to avoid context blowup.
- Record token usage, duration, attempts, and result classification per delegation.
- Preserve active loop state across reload and compaction.
- Treat journal writes as part of the safety model: if the journal cannot be written, the loop should fail closed rather than continue invisibly.

## Testing Decisions

- Tests should verify event sequence monotonicity, append-only behavior, JSONL replay, and partial-tail recovery.
- Tests should verify append-before-publish and durable settlement ordering.
- Tests should verify that each lifecycle transition writes the expected event kind.
- Tests should verify deterministic projections for lifecycle, delegation, validation, review, blocker, and requirement-reference events.
- Tests should verify that supervisor context is bounded and derived from projections without raw-log scanning.
- Tests should verify that completion rejects missing, stale, cross-run, or fabricated event references while leaving semantic sufficiency to the supervisor.
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

Compozy's append-before-publish journal pattern, typed settlement events, result snapshot ordering, and deterministic read projections are the primary reference. For the MVP, per-run JSONL plus a derived state/projection snapshot is sufficient; SQLite is unnecessary until query or scale requirements justify it. Raw events answer what happened, deterministic projections organize those facts, and the supervisor decides what they mean for the objective.
