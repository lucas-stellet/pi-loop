# PRD 001: Loop Supervisor Mode

## Problem Statement

Users want to hand Pi a broad objective, such as a GitHub issue, Linear task, or multi-part implementation request, and have the system continue autonomously until the objective is complete. Today, the main agent can directly read, edit, and execute commands, which makes autonomous loops risky: the same agent that decides what should happen can also mutate the codebase, run long tasks, drift from the objective, or stop after producing only a plan.

The desired behavior is a restricted control-plane agent. When loop mode is active, the main agent should supervise and coordinate the work, but should not execute implementation tasks itself.

## Solution

Add a loop mode that turns the main Pi agent into a restricted supervisor. The supervisor manages the objective, plan, nits, decisions, and completion checklist through loop-scoped markdown control files. It receives a compact runtime projection of structured loop events as its evidence context; it does not need to inspect raw event logs. It cannot inspect arbitrary project files, run shell commands, or edit implementation files. All real work is delegated to background subagents, chains, or workflows.

The loop ends only when the supervisor calls an explicit completion tool after judging the objective requirement-by-requirement against the projected evidence, or when the loop is paused, budget-limited, or fails due to a non-recoverable error. The semantic completion decision belongs to the supervisor. Runtime code validates the integrity and current-run provenance of the supervisor's cited evidence, but does not replace that semantic judgment with a deterministic completion policy.

## User Stories

1. As a user, I want to start loop mode with a broad objective, so that Pi keeps working until the objective is complete.
2. As a user, I want the main agent to act only as supervisor, so that code changes are made by delegated workers rather than the control-plane agent.
3. As a user, I want the supervisor's available tools to be restricted, so that autonomy does not imply unrestricted shell or file access.
4. As a user, I want the supervisor to maintain markdown control files, so that the plan, state, nits, decisions, and evidence are visible and auditable.
5. As a user, I want the supervisor to continue automatically after each turn when the objective is incomplete, so that I do not need to keep prompting it manually.
6. As a user, I want the supervisor to ask me only for genuinely blocking decisions, so that it remains autonomous by default.
7. As a user, I want loop mode to pause cleanly, so that I can regain control without stale tool calls continuing in the background.
8. As a user, I want loop mode to enforce token or iteration budgets, so that autonomous execution cannot run indefinitely.
9. As a user, I want completion to be explicit and verifiable, so that the agent cannot silently declare success while tests, reviews, or requirements remain unresolved.
10. As a maintainer, I want loop mode state to survive reloads and compaction, so that long-running objectives can continue safely across Pi session events.

## Implementation Decisions

- Loop mode introduces a supervisor state machine with explicit states for active work, paused work, budget-limited work, failed work, and completed work.
- The main agent's active tools are replaced with a supervisor allowlist while loop mode is active.
- Runtime enforcement must block prohibited tool calls even if the model attempts them. Prompt guidance is not sufficient.
- Supervisor tools are limited to loop control, markdown control-file updates, delegation, status inspection, and completion.
- The supervisor may write only loop-scoped markdown control artifacts. It may not write implementation files or arbitrary project files.
- The supervisor receives an injected prompt that defines its role as orchestrator, not executor.
- Completion requires a dedicated completion tool. Every `loop_complete` call requires a textual summary and a non-empty structured assessment set with exactly one assessment for every projected requirement; the completion tool rejects empty, contradictory, structurally incomplete, or ungrounded assessments.
- The supervisor makes the semantic decision to continue or complete after reviewing a deterministic projection of current-run facts grouped by requirement.
- Completion validation checks assessment structure and that cited event references exist, belong to the active run, and are represented accurately; it does not decide whether the evidence is semantically sufficient.
- Markdown control files are human-readable planning and decision artifacts, not the authoritative source for runtime evidence or terminal state.
- The supervisor should prefer delegation over direct work whenever it needs code context, implementation, testing, review, or external task-tracker inspection.
- The system should keep loop state independent from normal chat context where possible, while still surfacing concise status to the user.
- If the system cannot enforce supervisor tool restrictions, loop mode must refuse to start.

## Testing Decisions

- Tests should focus on externally observable safety behavior: which tools are active, which calls are blocked, and how loop state transitions occur.
- Add tests for starting loop mode, pausing, resuming, budget limiting, and completion.
- Add tests proving prohibited built-in tools are blocked during loop mode.
- Add tests proving markdown writes outside the loop control scope are rejected.
- Add tests proving completion fails when its required summary is contradictory or evidence is missing, or its required assessment set is omitted, incomplete, or ungrounded.
- Add tests for session reload and compaction recovery.
- Avoid testing prompt wording as implementation detail except where wording is part of the public contract shown to the model.

## Out of Scope

- Full sandboxing of worker agents at the operating-system level.
- Parallel worktree orchestration and automatic merge conflict resolution.
- A general-purpose daemon for all loop runs.
- Replacing existing Pi subagent or workflow systems.
- Building a complete GitHub or Linear integration inside this PRD.

## Further Notes

This PRD defines the control-plane behavior. Delegation mechanics, event journaling, and tracker ingestion are covered by separate PRDs.
