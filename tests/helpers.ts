import { open, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Patch a FileHandle prototype method for the duration of `run`, always restoring it. */
export async function withFileHandleMethod<K extends "sync" | "writeFile", T>(
	method: K,
	install: (original: FileHandle[K]) => FileHandle[K],
	run: () => Promise<T>,
): Promise<T> {
	const probe = await open(join(tmpdir(), `pi-loop-fh-${method}-probe`), "w");
	const prototype = Object.getPrototypeOf(probe) as Record<K, FileHandle[K]>;
	const original = prototype[method];
	prototype[method] = install(original);
	await probe.close();
	try {
		return await run();
	} finally {
		prototype[method] = original;
	}
}
