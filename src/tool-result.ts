import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

export type ToolResult = AgentToolResult<unknown>;

export function textResult(text: string): ToolResult {
	return {
		content: [{ type: "text", text }],
		details: undefined,
	};
}
