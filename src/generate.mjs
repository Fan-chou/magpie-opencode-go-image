import { downloadImage, buildResponsesBody, isAbort, postResponses } from "./client.mjs"
import { extractImages } from "./parse.mjs"
import { formatLabel, sniffImage } from "./image.mjs"
import { isLunaModel } from "./models.mjs"
import { resolveGatewayBaseUrl } from "./options.mjs"
import { resolveImageGenRequest } from "./request.mjs"
import { resolveOutDir, saveImage } from "./save.mjs"

export async function generateImage({ cfg, model, args, ctx }) {
  const request = await resolveImageGenRequest({ model, args })
  const outDir = resolveOutDir(args?.out_dir, cfg.outDir, ctx)
  const baseUrl = resolveGatewayBaseUrl(cfg.baseUrl)
  const body = buildResponsesBody(request)
  const started = Date.now()
  const { signal, reason, cancel } = combineSignals(ctx?.abort, cfg.timeoutMs)

  try {
    let json
    try {
      json = await postResponses({ baseUrl, bearer: cfg.bearer, body, signal })
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw new Error(abortMessage(reason(), cfg.timeoutMs))
      throw err
    }

    const extracted = extractImages(json)
    if (extracted.gif) throw new Error("GIF output is not enabled for OpenCode Go image generation")

    const materialized = []
    for (const image of extracted.images) {
      if (image.bytes) {
        materialized.push(image)
        continue
      }
      if (!image.url) continue
      let bytes
      try {
        bytes = await downloadImage(image.url, { signal, bearer: cfg.bearer, baseUrl })
      } catch (err) {
        if (isAbort(err) || signal.aborted) throw new Error(abortMessage(reason(), cfg.timeoutMs))
        throw err
      }
      const info = sniffImage(bytes)
      if (!info) throw new Error("image URL did not return a PNG or JPEG")
      if (info.gif) throw new Error("GIF output is not enabled for OpenCode Go image generation")
      materialized.push({ bytes, ...info, revised_prompt: image.revised_prompt })
    }

    if (!materialized.length) throw new Error(missingMessage(extracted))

    const prefix = isLunaModel(model) ? "luna" : "grok"
    const saved = []
    for (const image of materialized) {
      const file = await saveImage({ bytes: image.bytes, ext: image.ext, outDir, prefix })
      saved.push({
        path: file,
        mime: image.mime,
        ext: image.ext,
        width: image.width,
        height: image.height,
        bytes: image.bytes.length,
        revised_prompt: image.revised_prompt || extracted.revisedPrompt || "",
      })
    }

    const ms = Date.now() - started
    const first = saved[0]
    const dim = first.width && first.height ? ` ${first.width}×${first.height}` : ""
    const head = saved.length > 1 ? `${saved.length} images. ` : ""
    const result = {
      path: first.path,
      paths: saved.map((item) => item.path),
      note: `${head}${formatLabel(first.ext)}${dim}, ${first.bytes} bytes, ${ms} ms`,
      response_id: extracted.responseId,
      model,
      mime: first.mime,
      width: first.width,
      height: first.height,
      bytes: first.bytes,
      ms,
    }
    if (first.revised_prompt) result.revised_prompt = clip(first.revised_prompt, 500)
    return result
  } finally {
    cancel()
  }
}

function missingMessage(extracted) {
  const parts = ["no PNG or JPEG in the OpenCode Go response"]
  const failure = extracted.failures.filter(Boolean).join("; ")
  if (failure) parts.push(failure)
  const types = extracted.summary.types
  parts.push(types.length ? `output: ${types.join(", ")}` : "output: empty")
  if (extracted.summary.text) parts.push(`text: ${clip(extracted.summary.text, 200)}`)
  if (extracted.responseId) parts.push(`response_id=${extracted.responseId}`)
  return parts.join(". ")
}

function combineSignals(caller, timeoutMs) {
  const controller = new AbortController()
  let why = "timeout"
  const timer = setTimeout(() => {
    if (controller.signal.aborted) return
    why = "timeout"
    controller.abort()
  }, timeoutMs)
  const onCaller = () => {
    if (controller.signal.aborted) return
    why = "aborted"
    controller.abort()
  }
  if (caller?.aborted) onCaller()
  else caller?.addEventListener("abort", onCaller)
  const cancel = () => {
    clearTimeout(timer)
    caller?.removeEventListener("abort", onCaller)
  }
  return { signal: controller.signal, reason: () => why, cancel }
}

function abortMessage(why, timeoutMs) {
  if (why === "aborted") return "OpenCode Go image request was aborted"
  return `OpenCode Go image request timed out after ${timeoutMs} ms`
}

function clip(value, limit) {
  const text = String(value).replace(/\s+/g, " ").trim()
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}…`
}
