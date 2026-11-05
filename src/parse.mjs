import { createHash } from "node:crypto"
import { decodeDataUrl, looksLikeBase64, sniffImage } from "./image.mjs"

const SKIP_KEYS = new Set([
  "revised_prompt",
  "id",
  "type",
  "status",
  "object",
  "role",
  "quality",
  "size",
  "background",
  "output_format",
  "format",
])

const MAX_TEXT = 20_000_000

/**
 * Find every `image_generation_call` in a Responses payload.
 * `result` may be raw base64, a data URL, an object, or a JSON string of those.
 */
export function extractImages(body) {
  const calls = []
  walkForCalls(body, calls, 0, new Set())
  const images = []
  const failures = []
  const seen = new Set()
  let revised = ""

  for (const call of calls) {
    const format = String(call.output_format || call.format || "").toLowerCase()
    if (format === "gif") {
      failures.push("GIF output is not enabled")
      continue
    }
    const prompt = typeof call.revised_prompt === "string" ? call.revised_prompt.trim() : ""
    if (prompt && !revised) revised = prompt

    const payloads = payloadsFromCall(call)
    if (payloads.failure) failures.push(payloads.failure)
    for (const image of payloads.images) {
      if (image.bytes) {
        const hash = createHash("sha256").update(image.bytes).digest("hex")
        if (seen.has(hash)) continue
        seen.add(hash)
      }
      images.push({ ...image, revised_prompt: prompt })
    }
  }

  return {
    responseId: readResponseId(body),
    images,
    failures,
    gif: images.length === 0 && failures.some((item) => item.includes("GIF")),
    revisedPrompt: revised,
    summary: outputSummary(body),
  }
}

export function readResponseId(body) {
  for (const item of [body, body?.response, body?.data]) {
    if (!item || typeof item !== "object") continue
    for (const key of ["id", "response_id"]) {
      const value = item[key]
      if (typeof value === "string" && value.trim()) return value.trim()
    }
  }
  return ""
}

export function outputSummary(body) {
  const types = []
  const texts = []
  const output = Array.isArray(body?.output) ? body.output : []
  for (const item of output) {
    if (item && typeof item === "object" && !Array.isArray(item) && item.type) types.push(String(item.type))
    collectText(item, texts, 0)
  }
  return { types, text: texts.join(" ").slice(0, 240) }
}

function walkForCalls(node, out, depth, seen) {
  if (node == null || depth > 12) return
  if (typeof node === "string") {
    const parsed = parseJsonContainer(node)
    if (parsed) walkForCalls(parsed, out, depth + 1, seen)
    return
  }
  if (typeof node !== "object") return
  if (seen.has(node)) return
  seen.add(node)
  if (!Array.isArray(node) && node.type === "image_generation_call") out.push(node)
  const values = Array.isArray(node) ? node : Object.values(node)
  for (const value of values) walkForCalls(value, out, depth + 1, seen)
}

function payloadsFromCall(call) {
  const root = call.result !== undefined ? call.result : firstPayloadField(call)
  if (root === undefined) {
    return { images: [], failure: call.status ? `status=${call.status}` : "image_generation_call has no result" }
  }
  const candidates = []
  collectCandidates(root, candidates, 0)
  const images = []
  const urls = []
  let sawGif = false
  for (const candidate of candidates) {
    if (candidate.url) {
      urls.push(candidate.url)
      continue
    }
    if (candidate.gif) {
      sawGif = true
      continue
    }
    const info = sniffImage(candidate.bytes)
    if (!info) continue
    if (info.gif) {
      sawGif = true
      continue
    }
    images.push({ bytes: candidate.bytes, ...info })
  }
  if (images.length) return { images, failure: "" }
  if (urls.length) return { images: urls.map((url) => ({ url })), failure: "" }
  if (sawGif) return { images: [], failure: "GIF output is not enabled" }
  return { images: [], failure: call.status ? `status=${call.status}` : "image_generation_call had no PNG or JPEG" }
}

function firstPayloadField(call) {
  for (const key of ["b64_json", "image_base64", "base64", "image", "data", "url", "image_url"]) {
    if (call[key] != null) return call[key]
  }
  return undefined
}

function collectCandidates(value, out, depth) {
  if (value == null || depth > 8) return
  if (typeof value === "string") {
    const text = value.trim()
    if (!text || text.length > MAX_TEXT) return
    if (/^data:/i.test(text)) {
      const decoded = decodeDataUrl(text)
      if (!decoded) return
      if (decoded.gif) out.push({ gif: true })
      else if (decoded.bytes?.length) out.push({ bytes: decoded.bytes })
      return
    }
    const parsed = parseJsonContainer(text)
    if (parsed) {
      collectCandidates(parsed, out, depth + 1)
      return
    }
    if (/^https?:\/\//i.test(text) && text.length <= 4096 && !/\s/.test(text)) {
      out.push({ url: text })
      return
    }
    if (looksLikeBase64(text)) {
      const bytes = Buffer.from(text.replace(/\s+/g, ""), "base64")
      if (bytes.length) out.push({ bytes })
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCandidates(item, out, depth + 1)
    return
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SKIP_KEYS.has(key)) continue
      collectCandidates(item, out, depth + 1)
    }
  }
}

function parseJsonContainer(value) {
  const text = String(value).trim()
  if (text.length < 2 || text.length > MAX_TEXT) return null
  const open = text[0]
  const close = text[text.length - 1]
  if (!((open === "{" && close === "}") || (open === "[" && close === "]"))) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function collectText(node, texts, depth) {
  if (node == null || depth > 6 || texts.length > 4) return
  if (typeof node === "string") {
    const text = node.trim()
    if (!text || text.length > 2000) return
    if (text.startsWith("data:image/") || looksLikeBase64(text) || text.startsWith("{") || text.startsWith("[")) return
    texts.push(text)
    return
  }
  if (typeof node !== "object") return
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, texts, depth + 1)
    return
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "text" || key === "refusal" || key === "message") collectText(value, texts, depth + 1)
    else if (key === "content" || key === "output" || key === "error") collectText(value, texts, depth + 1)
  }
}
