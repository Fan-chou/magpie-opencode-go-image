import { GROK_MODEL, isLunaModel, LUNA_MODELS, MAX_IMAGE_BYTES } from "./models.mjs"
import { imageGenerationTool } from "./request.mjs"

/**
 * Encode an ImageGenRequest as a Responses body.
 * Every Luna model sends tool_choice. Grok must not: Magpie answers 422 Endpoint is unavailable.
 * previous_response_id is copied for Grok only. store is always false. GIF is never requested.
 * References become one input_text plus one input_image each, in order.
 * With none, input stays the prompt string.
 */
export function buildResponsesBody(request = {}) {
  const { model, prompt, previousResponseId } = request
  const luna = isLunaModel(model)
  if (!luna && model !== GROK_MODEL) {
    throw new Error(`model must be ${LUNA_MODELS.join(" or ")} or ${GROK_MODEL}`)
  }
  const imageUrls = referenceImageUrls(request.references)
  const body = {
    model,
    input: imageUrls.length ? multimodalInput(prompt, imageUrls) : prompt,
    tools: [imageGenerationTool(request.tool ?? {}, { luna, hasReference: imageUrls.length > 0 })],
    store: false,
  }
  if (luna) body.tool_choice = { type: "image_generation" }
  if (model === GROK_MODEL && previousResponseId) body.previous_response_id = previousResponseId
  assertNoGifRequest(body)
  if (!model.startsWith("opencode-go/")) throw new Error("model must keep the opencode-go/ prefix")
  return body
}

function referenceImageUrls(references) {
  if (references == null) return []
  if (!Array.isArray(references)) throw new Error("references is an array of image URLs")
  return references.map((imageUrl) => {
    if (typeof imageUrl !== "string" || !imageUrl) throw new Error("reference image_url is empty")
    if (/^data:image\/gif\b/i.test(imageUrl)) throw new Error("refusing to request GIF output")
    if (!/^data:image\//i.test(imageUrl) && !/^https:\/\//i.test(imageUrl)) {
      throw new Error("reference image_url must be https or a data:image URL")
    }
    return imageUrl
  })
}

function multimodalInput(prompt, imageUrls) {
  return [{
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: prompt },
      ...imageUrls.map((imageUrl) => ({ type: "input_image", image_url: imageUrl })),
    ],
  }]
}

/**
 * Refuse a body that asks for GIF. Reference payloads are omitted from the scan:
 * base64 can contain the letters "gif" without being a GIF.
 */
function assertNoGifRequest(body) {
  const scan = JSON.parse(JSON.stringify(body))
  if (Array.isArray(scan.input)) {
    for (const item of scan.input) {
      if (!Array.isArray(item?.content)) continue
      for (const part of item.content) {
        if (part?.type === "input_image") part.image_url = ""
      }
    }
  }
  if (JSON.stringify(scan).toLowerCase().includes("gif")) throw new Error("refusing to request GIF output")
}

export function responsesUrl(baseUrl) {
  return `${baseUrl}/v1/responses`
}

export async function postResponses({ baseUrl, bearer, body, signal }) {
  const url = responsesUrl(baseUrl)
  if (url.includes("/images/generations")) throw new Error("refusing to call /v1/images/generations")
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
  }
  if (bearer) headers.authorization = `Bearer ${bearer}`

  let response
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    })
  } catch (err) {
    if (isAbort(err)) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`OpenCode Go request failed (${url}): ${reason}`)
  }

  const text = await response.text()
  let json = null
  let parseError = null
  try {
    json = parseResponseBody(text, response.headers.get("content-type") || "")
  } catch (err) {
    parseError = err
  }

  if (!response.ok) {
    const detail = errorDetail(json, text)
    throw new Error(formatHttpError({ status: response.status, detail, model: body.model, sentToolChoice: "tool_choice" in body }))
  }
  if (parseError) throw parseError
  if (!json || typeof json !== "object") throw new Error("OpenCode Go returned an empty body")
  if (json.error && !json.output) {
    throw new Error(formatHttpError({
      status: response.status,
      detail: errorDetail(json, text),
      model: body.model,
      sentToolChoice: "tool_choice" in body,
    }))
  }
  return json
}

export function parseResponseBody(text, contentType = "") {
  const trimmed = String(text ?? "").replace(/^\uFEFF/, "").trim()
  if (!trimmed) return null
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed)
  if (contentType.includes("text/event-stream") || trimmed.startsWith("data:")) return parseEventStream(trimmed)
  throw new Error("OpenCode Go returned a body that is not JSON")
}

function parseEventStream(text) {
  let last = null
  for (const block of text.split(/\n\n+/)) {
    const data = block
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
    if (!data || data === "[DONE]") continue
    let json
    try {
      json = JSON.parse(data)
    } catch {
      continue
    }
    last = json
    if (json.response && typeof json.type === "string" && json.type.endsWith("completed")) return json.response
  }
  if (last?.response?.output) return last.response
  if (last?.output || last?.id) return last
  if (last) return last
  throw new Error("OpenCode Go event stream had no JSON response")
}

export async function downloadImage(url, { signal, bearer, baseUrl }) {
  let current = url
  for (let hop = 0; hop < 3; hop += 1) {
    let target
    try {
      target = new URL(current)
    } catch {
      throw new Error(`image URL is not a URL: ${current}`)
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("image URL must be http or https")
    }
    const headers = {}
    if (bearer && sameOrigin(baseUrl, target)) headers.authorization = `Bearer ${bearer}`
    const response = await fetch(target, { signal, headers, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location")
      if (!location) throw new Error(`image URL redirect ${response.status} has no location`)
      current = new URL(location, target).href
      continue
    }
    if (!response.ok) throw new Error(`image URL returned HTTP ${response.status}`)
    const declared = Number(response.headers.get("content-length"))
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      throw new Error(`image is larger than ${MAX_IMAGE_BYTES} bytes`)
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`image is larger than ${MAX_IMAGE_BYTES} bytes`)
    return bytes
  }
  throw new Error("image URL redirected too many times")
}

export function formatHttpError({ status, detail, model, sentToolChoice }) {
  const head = `OpenCode Go ${model} returned HTTP ${status}: ${detail}`
  if (status === 422) {
    const choice = sentToolChoice ? "This request sent tool_choice." : "This request omitted tool_choice."
    return `${head}. ${choice} opencode-go/grok-4.7 must omit tool_choice or Magpie returns 422 Endpoint is unavailable. Luna models send tool_choice {type:"image_generation"}.`
  }
  if (status === 401 || status === 403) {
    return `${head}. Keep the opencode-go/ model prefix so Magpie does not route the call to Zen. Loopback needs no Authorization; set bearer or apiKey only for a gateway off loopback.`
  }
  return head
}

export function isAbort(err) {
  return err?.name === "AbortError" || err?.name === "TimeoutError" || err?.code === "ABORT_ERR"
}

function errorDetail(json, text) {
  if (json && typeof json === "object") {
    const message = json.error?.message || json.message || json.error
    if (typeof message === "string") return clip(message)
    if (message && typeof message === "object") return clip(JSON.stringify(message))
    return clip(JSON.stringify(json))
  }
  return clip(text)
}

function clip(value, limit = 400) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}

function sameOrigin(baseUrl, url) {
  try {
    return new URL(baseUrl).origin === url.origin
  } catch {
    return false
  }
}
