const MAX_EVENT_LINE_BYTES = 64 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
	return isObject(block) && block.type === "text" && typeof block.text === "string";
}

/**
 * Concatenate documented text blocks in content order with no separators.
 * Returns undefined when no text block is present (distinct from explicit empty text).
 */
function selectedAssistantText(content: readonly unknown[]): string | undefined {
	let text: string | undefined;
	for (const block of content) {
		if (!isTextBlock(block)) continue;
		text = (text ?? "") + block.text;
	}
	return text;
}

/** Incrementally selects documented Pi assistant final text without retaining raw stdout. */
export class PiJsonFinalCapture {
	#line = Buffer.alloc(0);
	#overlong = false;
	#final: Buffer | undefined;

	write(chunk: Buffer): void {
		let start = 0;
		for (let index = 0; index < chunk.length; index += 1) {
			if (chunk[index] !== 0x0a) continue;
			this.#append(chunk.subarray(start, index));
			this.#parseLine();
			this.#line = Buffer.alloc(0);
			this.#overlong = false;
			start = index + 1;
		}
		this.#append(chunk.subarray(start));
	}

	finish(): Buffer | undefined {
		this.#parseLine();
		return this.#final;
	}

	#append(content: Buffer): void {
		if (this.#overlong || content.length === 0) return;
		if (this.#line.length + content.length > MAX_EVENT_LINE_BYTES) {
			this.#line = Buffer.alloc(0);
			this.#overlong = true;
			return;
		}
		this.#line = Buffer.concat([this.#line, content]);
	}

	#parseLine(): void {
		if (this.#overlong || this.#line.length === 0) return;
		const line = this.#line.at(-1) === 0x0d ? this.#line.subarray(0, -1) : this.#line;
		try {
			const event: unknown = JSON.parse(utf8.decode(line));
			if (!isObject(event) || event.type !== "message_end" || !isObject(event.message)) return;
			const { message } = event;
			if (message.role !== "assistant" || !Array.isArray(message.content)) return;
			const text = selectedAssistantText(message.content);
			if (text !== undefined) {
				this.#final = Buffer.from(text, "utf8");
			}
		} catch {
			// Child output is untrusted transport data; malformed lines have no authority.
		}
	}
}
