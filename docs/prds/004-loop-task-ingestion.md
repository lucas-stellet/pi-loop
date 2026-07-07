# PRD 004: Objective and Task Ingestion

## Problem Statement

Users want to start a loop from real task sources such as GitHub issues, Linear tickets, or a link to a parent task containing multiple sub-issues. The supervisor needs enough context to decompose the objective, decide which subagents or chains to run, and verify completion. If ingestion is ad hoc, the loop risks missing requirements, ignoring sub-issues, or treating a large product task as a small code edit.

## Solution

Add objective ingestion that normalizes user-provided text, GitHub issue links, Linear task links, and other supported task references into a loop objective document. The ingestion step extracts requirements, sub-issues, acceptance criteria, blockers, linked artifacts, and open questions. The supervisor then uses the normalized objective to plan and delegate work.

The main agent remains restricted during loop mode. If ingestion requires network access, tracker access, repository inspection, or large context gathering, the supervisor delegates that work to a scout/research subagent rather than directly using unrestricted tools.

## User Stories

1. As a user, I want to pass a GitHub issue link to loop mode, so that the loop can work from the issue requirements.
2. As a user, I want to pass a Linear task link to loop mode, so that the loop can work from my existing task tracker.
3. As a user, I want linked sub-issues to be discovered, so that the loop does not complete only the parent shell task.
4. As a user, I want acceptance criteria to become a checklist, so that completion is evaluated against the original task.
5. As a user, I want comments and follow-up notes to be considered, so that recent clarifications are not missed.
6. As a supervisor agent, I want a normalized objective document, so that I can plan without repeatedly re-fetching task context.
7. As a supervisor agent, I want unknowns and blockers separated from requirements, so that I ask the user only for genuinely blocking decisions.
8. As a maintainer, I want ingestion to be source-aware, so that GitHub, Linear, and plain-text objectives can have different adapters while producing the same normalized shape.
9. As a user, I want unsupported sources to fail clearly, so that the loop does not hallucinate task details.
10. As a user, I want credentials or permission failures to pause the loop, so that it does not continue with incomplete source context.

## Implementation Decisions

- Introduce a normalized objective model used by the supervisor regardless of source.
- The normalized objective should include source metadata, requirements, sub-issues, acceptance criteria, blockers, open questions, and evidence needed for completion.
- Network or tracker access should happen through delegated scouts or source-specific ingestion helpers, not through unrestricted supervisor tools.
- If source content cannot be fetched completely, the loop should pause or ask for the missing access rather than inventing details.
- Parent tasks with sub-issues should become a decomposition input for delegation planning.
- Comments and linked tasks should be included when available because they often contain acceptance criteria or scope changes.
- The supervisor should convert the normalized objective into a completion checklist before delegating implementation work.
- Ingestion results should be recorded as loop artifacts and journal events.
- Task source adapters should be independently testable.

## Testing Decisions

- Tests should cover plain text objectives, GitHub issue-like input, Linear task-like input, missing permissions, missing sub-issues, and unsupported URLs.
- Tests should verify that acceptance criteria become completion checklist items.
- Tests should verify that linked sub-issues are represented separately from parent requirements.
- Tests should verify that failed ingestion pauses or fails safely instead of producing guessed requirements.
- Tests should verify that ingestion artifacts are recorded in loop state and available to the supervisor.
- Adapter tests should use recorded fixtures or fake clients rather than live network calls.

## Out of Scope

- Full bidirectional sync back to GitHub or Linear.
- Creating or updating Linear tasks.
- Automatically closing GitHub issues.
- Full issue-tracker search across organizations.
- Supporting every possible tracker in the first version.

## Further Notes

This PRD makes the loop useful for real work intake. It should be implemented after the supervisor restriction and delegation contracts are clear, because ingestion must not accidentally grant the supervisor broad execution tools.
