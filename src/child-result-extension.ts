import { writeSync } from "node:fs";

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type FullWriter = (fd: number, bytes: Buffer, offset: number, length: number) => number;

const nodeWrite: FullWriter = (fd, bytes, offset, length) => writeSync(fd, bytes, offset, length);

/** Write every byte or fail rather than accepting a truncated transport document. */
export function writeAllToFd(fd: number, bytes: Buffer, write: FullWriter = nodeWrite): void {
	let offset = 0;
	while (offset < bytes.length) {
		const length = bytes.length - offset;
		const written = write(fd, bytes, offset, length);
		if (!Number.isInteger(written) || written <= 0 || written > length) {
			throw new Error("Unable to write complete loop result.");
		}
		offset += written;
	}
}

export default function (pi: ExtensionAPI): void {
	let claimed = false;
	pi.registerTool(
		defineTool({
			name: "loop_result",
			label: "Loop result",
			description: "Return the final opaque result to the loop runtime.",
			parameters: Type.Object({
				result: Type.Object({}, { additionalProperties: true }),
			}),
			async execute(_toolCallId, params) {
				if (claimed) throw new Error("loop_result was already called.");
				claimed = true;
				const result =
					typeof params === "object" && params !== null && Object.hasOwn(params, "result")
						? (params as { result: unknown }).result
						: undefined;
				if (typeof result !== "object" || result === null || Array.isArray(result)) {
					throw new Error("loop_result requires an object result.");
				}
				const serialized = JSON.stringify(result);
				if (typeof serialized !== "string") throw new Error("loop_result result is not serializable.");
				writeAllToFd(3, Buffer.from(serialized, "utf8"));
				return {
					content: [{ type: "text" as const, text: "Result received." }],
					details: {},
					terminate: true,
				};
			},
		}),
	);
}
