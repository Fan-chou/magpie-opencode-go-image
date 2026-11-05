import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { buildResponsesBody, parseResponseBody } from "../src/client.mjs"
import { sniffImage } from "../src/image.mjs"
import { GROK_MODEL, LUNA_ALT_MODEL, LUNA_MODEL, normalizeLunaModel } from "../src/models.mjs"
import { normalizeOptions, resolveGatewayBaseUrl } from "../src/options.mjs"
import { extractImages } from "../src/parse.mjs"

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures")
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

async function fixture(name) {
  return JSON.parse(await readFile(path.join(fixtureDir, name), "utf8"))
}

describe("extractImages", () => {
  it("reads a raw base64 PNG from image_generation_call", async () => {
    const found = extractImages(await fixture("luna-png.json"))
    assert.equal(found.responseId, "resp_luna_png")
    assert.equal(found.images.length, 1)
    assert.equal(found.images[0].ext, "png")
    assert.equal(found.images[0].width, 1)
    assert.equal(found.images[0].height, 1)
    assert.equal(found.revisedPrompt, "a red circle on white")
    assert.equal(found.images[0].bytes.toString("base64"), PNG)
  })

  it("reads a data URL nested in an object", async () => {
    const found = extractImages(await fixture("data-url.json"))
    assert.equal(found.responseId, "resp_data_url")
    assert.equal(found.images.length, 1)
    assert.equal(found.images[0].mime, "image/png")
    assert.equal(found.images[0].width, 1)
  })

  it("reads a call that was itself a JSON string, whose result is another JSON string", async () => {
    const found = extractImages(await fixture("nested-json-string.json"))
    assert.equal(found.responseId, "resp_nested")
    assert.equal(found.images.length, 1)
    assert.equal(found.images[0].ext, "png")
  })

  it("keeps base64 that contains whitespace", () => {
    const folded = PNG.replace(/(.{16})/g, "$1\n")
    const found = extractImages({
      id: "resp_fold",
      output: [{ type: "image_generation_call", result: folded }],
    })
    assert.equal(found.images.length, 1)
    assert.equal(found.images[0].width, 1)
  })

  it("dedupes the same PNG when result lists it twice", () => {
    const found = extractImages({
      id: "resp_dup",
      output: [{
        type: "image_generation_call",
        result: { b64_json: PNG, image: PNG },
      }],
    })
    assert.equal(found.images.length, 1)
  })

  it("reports a URL when the call has no bytes", () => {
    const found = extractImages({
      id: "resp_url",
      output: [{ type: "image_generation_call", result: { url: "https://cdn.example/cat.png" } }],
    })
    assert.equal(found.images.length, 1)
    assert.equal(found.images[0].url, "https://cdn.example/cat.png")
  })

  it("flags GIF data URLs and does not return bytes", async () => {
    const found = extractImages(await fixture("gif-data-url.json"))
    assert.equal(found.images.length, 0)
    assert.equal(found.gif, true)
    assert.match(found.failures.join(" "), /GIF/)
  })

  it("describes a text-only response", async () => {
    const body = await fixture("no-image.json")
    const found = extractImages(body)
    assert.equal(found.images.length, 0)
    assert.equal(found.gif, false)
    assert.deepEqual(found.summary.types, ["message"])
    assert.match(found.summary.text, /cannot draw/)
  })
})

describe("image headers", () => {
  it("reads a JPEG SOF size", () => {
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xc0, 0x00, 0x0b, 0x08, 0x05, 0x80, 0x05, 0x80, 0x01, 0x01, 0x11, 0x00,
      0xff, 0xd9,
    ])
    const info = sniffImage(jpeg)
    assert.equal(info.ext, "jpg")
    assert.equal(info.width, 1408)
    assert.equal(info.height, 1408)
    assert.equal(info.gif, false)
  })

  it("recognizes GIF magic", () => {
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)])
    assert.equal(sniffImage(gif).gif, true)
  })
})

describe("request body", () => {
  it("sends tool_choice for Luna and omits it for Grok", () => {
    const luna = buildResponsesBody({ model: LUNA_MODEL, prompt: "red circle" })
    assert.equal(luna.model, "opencode-go/gpt-6-luna")
    assert.deepEqual(luna.tool_choice, { type: "image_generation" })
    const luna56 = buildResponsesBody({ model: LUNA_ALT_MODEL, prompt: "red circle" })
    assert.equal(luna56.model, "opencode-go/gpt-5.6-luna")
    assert.deepEqual(luna56.tool_choice, { type: "image_generation" })
    assert.deepEqual(luna.tools, [{ type: "image_generation" }])
    assert.equal(luna.store, false)
    assert.equal(luna.previous_response_id, undefined)

    const grok = buildResponsesBody({
      model: GROK_MODEL,
      prompt: "make it blue",
      previousResponseId: "resp_prev",
    })
    assert.equal(grok.model, "opencode-go/grok-4.7")
    assert.equal("tool_choice" in grok, false)
    assert.equal(grok.previous_response_id, "resp_prev")
    assert.equal(JSON.stringify(grok).toLowerCase().includes("gif"), false)
    assert.equal(JSON.stringify(luna).toLowerCase().includes("gif"), false)
  })

  it("rejects an unprefixed model", () => {
    assert.throws(() => buildResponsesBody({ model: "grok-4.7", prompt: "x" }), /opencode-go/)
    assert.throws(() => buildResponsesBody({ model: "gpt-5.6-luna", prompt: "x" }), /opencode-go/)
  })
})

describe("normalizeLunaModel", () => {
  it("defaults to gpt-6-luna and prefixes the two allowed ids", () => {
    assert.equal(normalizeLunaModel(undefined), LUNA_MODEL)
    assert.equal(normalizeLunaModel(""), LUNA_MODEL)
    assert.equal(normalizeLunaModel("  gpt-6-luna  "), LUNA_MODEL)
    assert.equal(normalizeLunaModel(LUNA_MODEL), LUNA_MODEL)
    assert.equal(normalizeLunaModel("gpt-5.6-luna"), LUNA_ALT_MODEL)
    assert.equal(normalizeLunaModel("opencode-go/gpt-5.6-luna"), LUNA_ALT_MODEL)
  })

  it("rejects every other Luna id before a request is built", () => {
    assert.throws(() => normalizeLunaModel("gpt-image-2"), /not allowed/)
    assert.throws(() => normalizeLunaModel("opencode-go/grok-4.7"), /not allowed/)
    assert.throws(() => normalizeLunaModel("opencode-go/gpt-5.6-luna-pro"), /not allowed/)
    assert.throws(() => normalizeLunaModel(5), /string/)
  })
})

describe("options", () => {
  it("leaves baseUrl empty and keeps the timeout default", () => {
    const cfg = normalizeOptions(undefined)
    assert.equal(cfg.baseUrl, "")
    assert.equal(cfg.bearer, "")
    assert.equal(cfg.timeoutMs, 120000)
    assert.equal(cfg.outDir, "")
    assert.equal(resolveGatewayBaseUrl(cfg.baseUrl, {}), "http://127.0.0.1:3425")
  })

  it("strips a trailing /v1 and prefers bearer over apiKey", () => {
    const cfg = normalizeOptions({
      baseUrl: "http://10.0.0.8:3425/v1/",
      bearer: "from-bearer",
      apiKey: "from-key",
      timeoutMs: "15000",
      outDir: "pics",
    })
    assert.equal(cfg.baseUrl, "http://10.0.0.8:3425")
    assert.equal(cfg.bearer, "from-bearer")
    assert.equal(cfg.timeoutMs, 15000)
    assert.equal(cfg.outDir, "pics")
  })

  it("uses apiKey when bearer is absent", () => {
    assert.equal(normalizeOptions({ apiKey: "k" }).bearer, "k")
  })

  it("rejects non-http base URLs, embedded secrets, and bad timeouts", () => {
    assert.throws(() => normalizeOptions({ baseUrl: "ftp://files" }), /http/)
    assert.throws(() => normalizeOptions({ baseUrl: "http://user:pass@127.0.0.1:3425" }), /password/)
    assert.throws(() => normalizeOptions({ timeoutMs: 50 }), /timeoutMs/)
    assert.throws(() => normalizeOptions({ bearer: "a\nb" }), /newline/)
  })
})

describe("resolveGatewayBaseUrl", () => {
  it("prefers an explicit baseUrl over MAGPIE_ADDR and the default", () => {
    const env = { MAGPIE_ADDR: "127.0.0.1:3999" }
    assert.equal(resolveGatewayBaseUrl("http://10.0.0.2:9/v1/", env), "http://10.0.0.2:9")
    assert.equal(resolveGatewayBaseUrl("  ", env), "http://127.0.0.1:3999")
    assert.equal(resolveGatewayBaseUrl("", {}), "http://127.0.0.1:3425")
  })

  it("reads a new MAGPIE_ADDR on the next call", () => {
    const first = { MAGPIE_ADDR: "127.0.0.1:4111" }
    const second = { MAGPIE_ADDR: "http://192.168.1.8:4222/" }
    assert.equal(resolveGatewayBaseUrl("", first), "http://127.0.0.1:4111")
    assert.equal(resolveGatewayBaseUrl("", second), "http://192.168.1.8:4222")
    assert.equal(resolveGatewayBaseUrl("http://10.9.9.9:1", second), "http://10.9.9.9:1")
  })

  it("rejects a MAGPIE_ADDR that is not host:port or an http URL", () => {
    assert.throws(() => resolveGatewayBaseUrl("", { MAGPIE_ADDR: "3425" }), /host:port/)
    assert.throws(() => resolveGatewayBaseUrl("", { MAGPIE_ADDR: "ftp://files" }), /http/)
  })
})

describe("event stream", () => {
  it("unwraps a response.completed event", () => {
    const sse = [
      "event: response.completed",
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_sse",
          output: [{ type: "image_generation_call", result: PNG }],
        },
      })}`,
      "",
    ].join("\n")
    const body = parseResponseBody(sse, "text/event-stream")
    const found = extractImages(body)
    assert.equal(found.responseId, "resp_sse")
    assert.equal(found.images[0].ext, "png")
  })
})
