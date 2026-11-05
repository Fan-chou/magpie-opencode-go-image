import { randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Call out_dir, then the plugin outDir, then `<directory>/opencode-go-images`.
 * An absolute path is used as given. A relative path is resolved from the agent directory.
 */
export function resolveOutDir(callOutDir, optionOutDir, ctx) {
  const directory = typeof ctx?.directory === "string" && ctx.directory ? ctx.directory : process.cwd()
  const chosen = firstPath(callOutDir) || firstPath(optionOutDir) || "opencode-go-images"
  if (chosen.includes("\0")) throw new Error("outDir contains a NUL byte")
  if (path.isAbsolute(chosen)) return chosen
  return path.resolve(directory, chosen)
}

/**
 * Write one still image. Names look like `luna-20261105T043200000Z-ab12cd.png`.
 * @returns {Promise<string>} absolute path
 */
export async function saveImage({ bytes, ext, outDir, prefix }) {
  await mkdir(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(".", "")
  const name = `${prefix}-${stamp}-${randomBytes(3).toString("hex")}.${ext}`
  const file = path.join(outDir, name)
  await writeFile(file, bytes)
  return file
}

function firstPath(value) {
  if (typeof value !== "string") return ""
  return value.trim()
}
