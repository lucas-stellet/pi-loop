export const SUPERVISOR_TOOL_NAMES = [
	"loop_start",
	"loop_pause",
	"loop_resume",
	"loop_complete",
	"loop_status",
	"loop_delegate",
	"loop_write",
] as const;

export type SupervisorToolName = (typeof SUPERVISOR_TOOL_NAMES)[number];

export const LOOP_CONTROL_FILES = [
	"objective.md",
	"plan.md",
	"state.md",
	"decisions.md",
	"evidence.md",
	"completion-checklist.md",
] as const;

const LOOP_CONTROL_FILE_SET = new Set<string>(LOOP_CONTROL_FILES);

export function isSupervisorToolName(toolName: string): toolName is SupervisorToolName {
	return (SUPERVISOR_TOOL_NAMES as readonly string[]).includes(toolName);
}

export function isLoopControlFile(file: string): boolean {
	return LOOP_CONTROL_FILE_SET.has(file);
}
