import { createTools } from "./src/tools.mjs"

/**
 * Magpie tools plugin. One async function, no default export.
 * @param {object} input
 * @param {object} [options]
 */
export async function MagpieOpenCodeGoImage(input, options) {
  return { tool: createTools(input, options) }
}
