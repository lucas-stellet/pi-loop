import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Pi extension entrypoint for pi-loop.
 *
 * This file intentionally contains no loop behavior yet. It exists so the
 * package can be discovered and loaded by Pi before feature slices are added.
 */
export default function piLoop(_pi: ExtensionAPI): void {
  // Feature tools, commands, and hooks will be added in PRD-driven slices.
}
