import { readFile as defaultReadFile } from "node:fs/promises"
import { sniffImage } from "./image.mjs"
import { GROK_MODEL, isLunaModel, LUNA_MODELS, MAX_IMAGE_BYTES } from "./models.mjs"

/** Only size Windows Magpie accepted for both Luna and Grok. 512x512 is under Luna's pixel budget. */
export const IMAGE_SIZE = "1024x1024"

/** Magpie Responses accepts one input_image per reference. Callers may pass at most this many. */
export const MAX_REFERENCE_IMAGES = 4

/** Both tools pass low or high through as tools[0].quality. */
export const IMAGE_QUALITIES = ["low", "high"]

/**
 * Resolved image request. Tool args are validated into this, then encoded.
 * previousResponseId is Grok only. references are already Responses image_url
 * values (data:image/...;base64,... or https:), in caller order. Local paths
 * never reach the body. Omitted when there are no references. Length is 1–4.
 *
 * @typedef {object} ImageGenRequest
 * @property {string} model
 * @property {string} prompt
 * @property {string} [previousResponseId]
 * @property {string[]} [references]
 * @property {{ type: "image_generation", action?: "edit", size?: string, quality?: "low" | "high" }} tool
 */

/**
 * Tool args → ImageGenRequest. `image` is a string or a string array.
 * A string becomes a one-element list. Empty array, empty string, and omit are
 * no references. More than 4 fails before any file is read. `n` is rejected.
 * Luna `previous_response_id` is not a field on the result.
 */
export async function resolveImageGenRequest({ model, args, readFile } = {}) {
  const luna = isLunaModel(model)
  if (!luna && model !== GROK_MODEL) {
    throw new Error(`model must be ${LUNA_MODELS.join(" or ")} or ${GROK_MODEL}`)
  }
  if (args?.n != null) throw new Error("n is not supported")

  const prompt = requirePrompt(args?.prompt)
  const images = normalizeImageArg(args?.image)
  const action = editAction(args?.edit)
  const tool = imageGenerationTool(
    { action, size: clean(args?.size), quality: clean(args?.quality) },
    { luna, hasReference: images.length > 0 },
  )

  /** @type {ImageGenRequest} */
  const request = { model, prompt, tool }
  if (!luna) {
    const previousResponseId = optionalId(args?.previous_response_id)
    if (previousResponseId) request.previousResponseId = previousResponseId
  }
  if (images.length) {
    const references = []
    for (const image of images) references.push(await referenceToImageUrl(image, { readFile }))
    request.references = references
  }
  return request
}

/**
 * Encode tools[0] from an already resolved tool, or from raw action/size/quality.
 * Refuses `n`, any size other than 1024x1024, and edit without a Luna reference.
 */
export function imageGenerationTool(tool = {}, { luna = false, hasReference = false } = {}) {
  if (tool == null || typeof tool !== "object" || Array.isArray(tool)) {
    throw new Error("image tool is an object")
  }
  if (tool.n != null) throw new Error("n is not supported")

  const out = { type: "image_generation" }
  if (tool.action != null && tool.action !== "") {
    if (tool.action !== "edit") throw new Error("image_generation action must be edit")
    if (!luna) throw new Error("edit is only supported on luna_image")
    if (!hasReference) throw new Error("edit requires image")
    out.action = "edit"
  }
  if (tool.size != null && tool.size !== "") {
    if (tool.size !== IMAGE_SIZE) throw new Error(`size must be ${IMAGE_SIZE}`)
    out.size = IMAGE_SIZE
  }
  if (tool.quality != null && tool.quality !== "") {
    if (!IMAGE_QUALITIES.includes(tool.quality)) throw new Error("quality must be low or high")
    out.quality = tool.quality
  }
  return out
}

/**
 * Local path, https URL, or data:image URL → a Responses image_url.
 * Paths are read and sniffed: PNG and JPEG become data:image/...;base64,...
 * GIF is refused and is never returned.
 */
export async function referenceToImageUrl(value, deps = {}) {
  if (typeof value !== "string") throw new Error("image is a string")
  const text = value.trim()
  if (!text) throw new Error("image is empty")
  if (/^data:/i.test(text)) return dataImageUrl(text)
  if (/^https:\/\//i.test(text)) return httpsImageUrl(text)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    throw new Error("image URL must be https or a data:image URL")
  }
  const readFile = deps.readFile ?? defaultReadFile
  return dataUrlFromPath(text, readFile)
}

function editAction(value) {
  if (value == null || value === false) return undefined
  if (value !== true) throw new Error("edit is a boolean")
  return "edit"
}

function normalizeImageArg(value) {
  if (value == null || value === "") return []
  if (typeof value === "string") {
    const text = value.trim()
    return text ? [text] : []
  }
  if (!Array.isArray(value)) throw new Error("image is a string or an array of strings")
  if (value.length > MAX_REFERENCE_IMAGES) {
    throw new Error(`image accepts at most ${MAX_REFERENCE_IMAGES} references`)
  }
  const images = []
  for (const item of value) {
    if (typeof item !== "string") throw new Error("image is a string or an array of strings")
    const text = item.trim()
    if (!text) throw new Error("image is empty")
    images.push(text)
  }
  return images
}

function clean(value) {
  if (value == null) return undefined
  if (typeof value !== "string") return value
  const text = value.trim()
  return text === "" ? undefined : text
}

function requirePrompt(value) {
  if (typeof value !== "string") throw new Error("prompt is a string")
  const text = value.trim()
  if (!text) throw new Error("prompt is empty")
  if (text.length > 16_000) throw new Error("prompt is longer than 16000 characters")
  return text
}

function optionalId(value) {
  if (value == null || value === "") return ""
  if (typeof value !== "string") throw new Error("previous_response_id is a string")
  const text = value.trim()
  if (!text) return ""
  if (text.length > 200) throw new Error("previous_response_id is too long")
  if (!/^[\w.-]+$/.test(text)) throw new Error("previous_response_id has unexpected characters")
  return text
}

function httpsImageUrl(text) {
  if (/\s/.test(text)) throw new Error("image URL contains whitespace")
  if (text.length > 4096) throw new Error("image URL is too long")
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error("image URL is not a URL")
  }
  if (url.protocol !== "https:") throw new Error("image URL must be https")
  if (url.username || url.password) throw new Error("image URL must not include a username or password")
  if (!url.hostname) throw new Error("image URL is missing a host")
  return url.href
}

function dataImageUrl(text) {
  const match = /^data:([^;,]+)?((?:;[^,]*)*),([\s\S]*)$/i.exec(text.trim())
  if (!match) throw new Error("image data URL must be data:image/<type>;base64,...")
  const mime = (match[1] || "").toLowerCase()
  const params = match[2] || ""
  const payload = (match[3] || "").replace(/\s+/g, "")
  if (mime === "image/gif") throw new Error("GIF images are not supported")
  if (mime !== "image/png" && mime !== "image/jpeg" && mime !== "image/jpg") {
    throw new Error("image data URL must be PNG or JPEG")
  }
  if (!/;base64/i.test(params)) throw new Error("image data URL must be base64")
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new Error("image data URL payload is not base64")
  }
  const bytes = Buffer.from(payload, "base64")
  if (bytes.length === 0) throw new Error("image data URL is empty")
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image is larger than ${MAX_IMAGE_BYTES} bytes`)
  return dataUrlFromBytes(bytes)
}

async function dataUrlFromPath(filePath, readFile) {
  if (filePath.includes("\0")) throw new Error("image path contains a NUL byte")
  let bytes
  try {
    bytes = await readFile(filePath)
  } catch (err) {
    if (err?.code === "ENOENT") throw new Error(`image file not found: ${filePath}`)
    if (err?.code === "EISDIR") throw new Error(`image path is a directory: ${filePath}`)
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`image file could not be read: ${filePath} (${reason})`)
  }
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.length === 0) throw new Error("image file is empty")
  if (buf.length > MAX_IMAGE_BYTES) throw new Error(`image is larger than ${MAX_IMAGE_BYTES} bytes`)
  return dataUrlFromBytes(buf)
}

function dataUrlFromBytes(bytes) {
  const info = sniffImage(bytes)
  if (info?.gif) throw new Error("GIF images are not supported")
  if (!info || (info.mime !== "image/png" && info.mime !== "image/jpeg")) {
    throw new Error("image must be a PNG or JPEG")
  }
  return `data:${info.mime};base64,${bytes.toString("base64")}`
}
