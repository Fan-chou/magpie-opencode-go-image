import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { MagpieOpenCodeGoImage } from "../index.mjs"
import { GROK_MODEL, LUNA_MODEL } from "../src/models.mjs"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)
const JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x05, 0x80, 0x05, 0x80, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
])

let dirs = []

afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const originalFetch = globalThis.fetch

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "magpie-go-image-"))
  dirs.push(dir)
  return dir
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("plugin module", () => {
  it("exports one plugin function and the two tool keys", async () => {
    const mod = await import("../index.mjs")
    assert.deepEqual(Object.keys(mod), ["MagpieOpenCodeGoImage"])
    assert.equal(mod.default, undefined)

    const dir = await tempDir()
    const hooks = await MagpieOpenCodeGoImage({ directory: dir, client: {} }, { outDir: dir, timeoutMs: 5000 })
    assert.deepEqual(Object.keys(hooks.tool), ["luna_image", "grok_image"])
    for (const key of ["luna_image", "grok_image"]) {
      const tool = hooks.tool[key]
      assert.equal(typeof tool.execute, "function")
      assert.equal(tool.args.type, "object")
      assert.deepEqual(tool.args.required, ["prompt"])
      assert.equal(typeof tool.description, "string")
      assert.ok(tool.description.length > 200)
    }
    assert.match(hooks.tool.luna_image.description, /tool_choice/)
    assert.match(hooks.tool.luna_image.description, /opencode-go\/gpt-6-luna/)
    assert.match(hooks.tool.luna_image.description, /gpt-5\.6-luna/)
    assert.deepEqual(hooks.tool.luna_image.args.properties.model.enum, [
      "opencode-go/gpt-6-luna",
      "gpt-6-luna",
      "opencode-go/gpt-5.6-luna",
      "gpt-5.6-luna",
    ])
    assert.equal("model" in hooks.tool.grok_image.args.properties, false)
    assert.match(hooks.tool.grok_image.description, /422/)
    assert.match(hooks.tool.grok_image.description, /previous_response_id/)
    assert.equal("previous_response_id" in hooks.tool.grok_image.args.properties, true)
    assert.equal("previous_response_id" in hooks.tool.luna_image.args.properties, false)
    assert.equal("n" in hooks.tool.luna_image.args.properties, false)
    assert.equal("n" in hooks.tool.grok_image.args.properties, false)
    assert.equal("edit" in hooks.tool.grok_image.args.properties, false)

    for (const key of ["luna_image", "grok_image"]) {
      const image = hooks.tool[key].args.properties.image
      assert.deepEqual(image.type, ["string", "array"])
      assert.equal(image.maxItems, 4)
      assert.deepEqual(image.items, { type: "string" })
      assert.match(image.description, /8 px/)
      assert.match(image.description, /4/)
      assert.deepEqual(hooks.tool[key].args.properties.size.enum, ["1024x1024"])
      assert.equal(hooks.tool[key].args.properties.size.enum.includes("512x512"), false)
      assert.deepEqual(hooks.tool[key].args.properties.quality.enum, ["low", "high"])
    }
    assert.equal(hooks.tool.luna_image.args.properties.edit.type, "boolean")
    assert.match(hooks.tool.grok_image.description, /8 px/)
  })

  it("rejects a plugin option that is not an http(s) URL", async () => {
    await assert.rejects(() => MagpieOpenCodeGoImage({}, { baseUrl: "ftp://nope" }), /http/)
  })
})

describe("tool execute", () => {
  it("posts Luna with tool_choice and writes a PNG", async () => {
    const dir = await tempDir()
    const seen = []
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), init })
      const body = JSON.parse(init.body)
      assert.equal(body.model, LUNA_MODEL)
      assert.deepEqual(body.tool_choice, { type: "image_generation" })
      assert.equal(body.previous_response_id, undefined)
      return jsonResponse({
        id: "resp_luna",
        output: [{
          type: "image_generation_call",
          status: "completed",
          revised_prompt: "red circle",
          result: PNG.toString("base64"),
        }],
      })
    }

    const hooks = await MagpieOpenCodeGoImage(
      { directory: dir, client: {} },
      { baseUrl: "http://127.0.0.1:5999/v1/", outDir: dir, timeoutMs: 5000 },
    )
    const result = await hooks.tool.luna_image.execute(
      { prompt: "red circle", previous_response_id: "resp_should_be_ignored" },
      { directory: dir },
    )

    assert.equal(seen.length, 1)
    assert.equal(seen[0].url, "http://127.0.0.1:5999/v1/responses")
    assert.equal(seen[0].init.method, "POST")
    assert.equal(seen[0].init.headers.authorization, undefined)
    assert.equal(result.response_id, "resp_luna")
    assert.equal(result.model, LUNA_MODEL)
    assert.equal(result.width, 1)
    assert.equal(result.height, 1)
    assert.equal(result.mime, "image/png")
    assert.match(result.note, /^PNG 1×1, \d+ bytes, \d+ ms$/)
    assert.equal(result.revised_prompt, "red circle")
    assert.equal(path.isAbsolute(result.path), true)
    assert.equal(path.dirname(result.path), dir)
    const written = await readFile(result.path)
    assert.deepEqual(written.subarray(0, 8), PNG.subarray(0, 8))
  })

  it("prefixes gpt-5.6-luna, keeps tool_choice, and rejects other ids before fetch", async () => {
    const dir = await tempDir()
    let body
    let posts = 0
    globalThis.fetch = async (_url, init) => {
      posts += 1
      body = JSON.parse(init.body)
      return jsonResponse({
        id: "resp_luna56",
        output: [{ type: "image_generation_call", result: PNG.toString("base64") }],
      })
    }
    const hooks = await MagpieOpenCodeGoImage({}, { outDir: dir, timeoutMs: 5000 })
    const result = await hooks.tool.luna_image.execute(
      { prompt: "older luna", model: "gpt-5.6-luna" },
      { directory: dir },
    )
    assert.equal(posts, 1)
    assert.equal(body.model, "opencode-go/gpt-5.6-luna")
    assert.deepEqual(body.tool_choice, { type: "image_generation" })
    assert.equal(result.model, "opencode-go/gpt-5.6-luna")
    assert.match(path.basename(result.path), /^luna-.*\.png$/)

    await assert.rejects(
      () => hooks.tool.luna_image.execute({ prompt: "nope", model: "gpt-image-2" }, { directory: dir }),
      /not allowed/,
    )
    assert.equal(posts, 1)

    await hooks.tool.grok_image.execute(
      { prompt: "square", model: "gpt-5.6-luna" },
      { directory: dir },
    )
    assert.equal(body.model, "opencode-go/grok-4.7")
    assert.equal("tool_choice" in body, false)
  })

  it("reads MAGPIE_ADDR on each call and lets an explicit baseUrl win", async () => {
    const dir = await tempDir()
    const previous = process.env.MAGPIE_ADDR
    const urls = []
    globalThis.fetch = async (url) => {
      urls.push(String(url))
      return jsonResponse({
        id: "resp_addr",
        output: [{ type: "image_generation_call", result: PNG.toString("base64") }],
      })
    }
    try {
      delete process.env.MAGPIE_ADDR
      const hooks = await MagpieOpenCodeGoImage({}, { outDir: dir, timeoutMs: 5000 })
      process.env.MAGPIE_ADDR = "127.0.0.1:5111"
      await hooks.tool.luna_image.execute({ prompt: "first" }, { directory: dir })
      process.env.MAGPIE_ADDR = "http://127.0.0.1:5222/v1/"
      await hooks.tool.luna_image.execute({ prompt: "second" }, { directory: dir })
      assert.deepEqual(urls, [
        "http://127.0.0.1:5111/v1/responses",
        "http://127.0.0.1:5222/v1/responses",
      ])

      const pinned = await MagpieOpenCodeGoImage({}, {
        baseUrl: "http://10.1.1.1:9",
        outDir: dir,
        timeoutMs: 5000,
      })
      process.env.MAGPIE_ADDR = "127.0.0.1:5333"
      await pinned.tool.grok_image.execute({ prompt: "pinned" }, { directory: dir })
      assert.equal(urls[2], "http://10.1.1.1:9/v1/responses")
    } finally {
      if (previous === undefined) delete process.env.MAGPIE_ADDR
      else process.env.MAGPIE_ADDR = previous
    }
  })

  it("posts Grok without tool_choice, sends bearer, and writes a JPEG", async () => {
    const dir = await tempDir()
    let captured
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), init, body: JSON.parse(init.body) }
      return jsonResponse({
        id: "resp_grok",
        output: [{
          type: "image_generation_call",
          result: `data:image/jpeg;base64,${JPEG.toString("base64")}`,
        }],
      })
    }
    const hooks = await MagpieOpenCodeGoImage(
      { client: {}, directory: dir },
      { baseUrl: "http://192.168.1.9:3425", apiKey: "lan-key", outDir: dir, timeoutMs: 5000 },
    )
    const result = await hooks.tool.grok_image.execute(
      { prompt: "blue square", previous_response_id: "resp_prev" },
      { directory: dir },
    )
    assert.equal(captured.url, "http://192.168.1.9:3425/v1/responses")
    assert.equal(captured.init.headers.authorization, "Bearer lan-key")
    assert.equal(captured.body.model, GROK_MODEL)
    assert.equal("tool_choice" in captured.body, false)
    assert.equal(captured.body.previous_response_id, "resp_prev")
    assert.equal(captured.body.store, false)
    assert.deepEqual(captured.body.tools, [{ type: "image_generation" }])
    assert.match(result.note, /^JPEG 1408×1408, \d+ bytes, \d+ ms$/)
    assert.equal(result.response_id, "resp_grok")
    assert.match(path.basename(result.path), /^grok-.*\.jpg$/)
  })

  it("downloads an http(s) image URL and keeps the bearer on the gateway origin only", async () => {
    const dir = await tempDir()
    const calls = []
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.authorization })
      if (String(url).endsWith("/v1/responses")) {
        return jsonResponse({
          id: "resp_remote",
          output: [{ type: "image_generation_call", result: "http://127.0.0.1:5999/files/cat.png" }],
        })
      }
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } })
    }
    const hooks = await MagpieOpenCodeGoImage({}, {
      baseUrl: "http://127.0.0.1:5999",
      bearer: "secret",
      outDir: dir,
      timeoutMs: 5000,
    })
    const result = await hooks.tool.luna_image.execute({ prompt: "cat" }, { directory: dir })
    assert.equal(calls[0].authorization, "Bearer secret")
    assert.equal(calls[1].url, "http://127.0.0.1:5999/files/cat.png")
    assert.equal(calls[1].authorization, "Bearer secret")
    assert.match(result.note, /^PNG 1×1/)

    calls.length = 0
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), authorization: init.headers.authorization })
      if (String(url).endsWith("/v1/responses")) {
        return jsonResponse({
          id: "resp_cdn",
          output: [{ type: "image_generation_call", result: "https://cdn.example/cat.png" }],
        })
      }
      return new Response(PNG, { status: 200 })
    }
    await hooks.tool.luna_image.execute({ prompt: "cat again" }, { directory: dir })
    assert.equal(calls[1].authorization, undefined)
  })

  it("explains HTTP 422 and a response with no image", async () => {
    const dir = await tempDir()
    const hooks = await MagpieOpenCodeGoImage({}, { outDir: dir, timeoutMs: 5000 })
    globalThis.fetch = async () => jsonResponse({ error: { message: "Endpoint is unavailable" } }, 422)
    await assert.rejects(
      () => hooks.tool.grok_image.execute({ prompt: "square" }, { directory: dir }),
      /422[\s\S]*omitted tool_choice[\s\S]*grok-4\.7/,
    )

    globalThis.fetch = async () => jsonResponse({
      id: "resp_empty",
      output: [{ type: "message", content: [{ type: "output_text", text: "refused" }] }],
    })
    await assert.rejects(
      () => hooks.tool.luna_image.execute({ prompt: "nope" }, { directory: dir }),
      /no PNG or JPEG[\s\S]*output: message[\s\S]*refused[\s\S]*resp_empty/,
    )
  })

  it("reports a timeout and an empty prompt without a late response", async () => {
    const dir = await tempDir()
    let posts = 0
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      posts += 1
      const fail = () => {
        const err = new Error("The operation was aborted")
        err.name = "AbortError"
        reject(err)
      }
      if (init.signal.aborted) fail()
      else init.signal.addEventListener("abort", fail, { once: true })
    })
    const hooks = await MagpieOpenCodeGoImage({}, { outDir: dir, timeoutMs: 1000 })
    await assert.rejects(
      () => hooks.tool.luna_image.execute({ prompt: "slow" }, { directory: dir }),
      /timed out after 1000 ms/,
    )
    assert.equal(posts, 1)
    await assert.rejects(
      () => hooks.tool.grok_image.execute({ prompt: "   " }, { directory: dir }),
      /prompt is empty/,
    )
    assert.equal(posts, 1)
  })

  it("refuses GIF bytes from a data URL", async () => {
    const dir = await tempDir()
    globalThis.fetch = async () => jsonResponse({
      id: "resp_gif",
      output: [{
        type: "image_generation_call",
        result: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      }],
    })
    const hooks = await MagpieOpenCodeGoImage({}, { outDir: dir, timeoutMs: 5000 })
    await assert.rejects(
      () => hooks.tool.luna_image.execute({ prompt: "animation" }, { directory: dir }),
      /GIF output is not enabled/,
    )
  })

  it("sends a Luna edit with size, quality, and a local reference image", async () => {
    const dir = await tempDir()
    const imagePath = path.join(dir, "ref.png")
    await writeFile(imagePath, PNG)
    let body
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body)
      return jsonResponse({
        id: "resp_edit",
        output: [{ type: "image_generation_call", result: PNG.toString("base64") }],
      })
    }
    const hooks = await MagpieOpenCodeGoImage({}, { outDir: dir, timeoutMs: 5000 })
    await hooks.tool.luna_image.execute({
      prompt: "make it blue",
      image: imagePath,
      edit: true,
      size: "1024x1024",
      quality: "high",
      previous_response_id: "resp_luna_ignored",
    }, { directory: dir })
    assert.equal(body.store, false)
    assert.equal(body.previous_response_id, undefined)
    assert.equal("n" in body, false)
    assert.equal("n" in body.tools[0], false)
    assert.deepEqual(body.tool_choice, { type: "image_generation" })
    assert.deepEqual(body.tools, [{
      type: "image_generation",
      action: "edit",
      size: "1024x1024",
      quality: "high",
    }])
    assert.deepEqual(body.input, [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "make it blue" },
        { type: "input_image", image_url: `data:image/png;base64,${PNG.toString("base64")}` },
      ],
    }])
  })

  it("sends Grok a reference image without tool_choice", async () => {
    const dir = await tempDir()
    let body
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body)
      return jsonResponse({
        id: "resp_grok_ref",
        output: [{
          type: "image_generation_call",
          result: `data:image/jpeg;base64,${JPEG.toString("base64")}`,
        }],
      })
    }
    const hooks = await MagpieOpenCodeGoImage({}, { outDir: dir, timeoutMs: 5000 })
    await hooks.tool.grok_image.execute({
      prompt: "add a hat",
      image: "https://cdn.example/cat.png",
      size: "1024x1024",
      quality: "low",
      previous_response_id: "resp_prev",
    }, { directory: dir })
    assert.equal("tool_choice" in body, false)
    assert.equal(body.store, false)
    assert.equal(body.previous_response_id, "resp_prev")
    assert.deepEqual(body.tools, [{ type: "image_generation", size: "1024x1024", quality: "low" }])
    assert.equal(body.input[0].content[1].image_url, "https://cdn.example/cat.png")
    assert.equal("action" in body.tools[0], false)
  })

  it("rejects n, 512x512, edit without image, and a GIF file before fetch", async () => {
    const dir = await tempDir()
    let posts = 0
    globalThis.fetch = async () => {
      posts += 1
      throw new Error("should not post")
    }
    const hooks = await MagpieOpenCodeGoImage({}, { outDir: dir, timeoutMs: 5000 })
    await assert.rejects(
      () => hooks.tool.luna_image.execute({ prompt: "x", n: 2 }, { directory: dir }),
      /n is not supported/,
    )
    await assert.rejects(
      () => hooks.tool.grok_image.execute({ prompt: "x", size: "512x512" }, { directory: dir }),
      /1024x1024/,
    )
    await assert.rejects(
      () => hooks.tool.luna_image.execute({ prompt: "x", edit: true }, { directory: dir }),
      /edit requires image/,
    )
    await assert.rejects(
      () => hooks.tool.grok_image.execute({ prompt: "x", edit: true, image: "https://cdn.example/a.png" }, { directory: dir }),
      /edit is only supported on luna_image/,
    )
    const gifPath = path.join(dir, "anim.gif")
    await writeFile(gifPath, Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)]))
    await assert.rejects(
      () => hooks.tool.luna_image.execute({ prompt: "x", image: gifPath }, { directory: dir }),
      /GIF/,
    )
    await assert.rejects(
      () => hooks.tool.luna_image.execute({
        prompt: "x",
        image: [
          "https://cdn.example/1.png",
          "https://cdn.example/2.png",
          "https://cdn.example/3.png",
          "https://cdn.example/4.png",
          "https://cdn.example/5.png",
        ],
      }, { directory: dir }),
      /at most 4/,
    )
    await assert.rejects(
      () => hooks.tool.luna_image.execute({ prompt: "x", image: [], edit: true }, { directory: dir }),
      /edit requires image/,
    )
    assert.equal(posts, 0)
  })

  it("sends one input_image per array item and still accepts a string", async () => {
    const dir = await tempDir()
    const bodies = []
    globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(init.body))
      return jsonResponse({
        id: "resp_multi",
        output: [{ type: "image_generation_call", result: PNG.toString("base64") }],
      })
    }
    const hooks = await MagpieOpenCodeGoImage({}, { outDir: dir, timeoutMs: 5000 })
    await hooks.tool.grok_image.execute({
      prompt: "string still works",
      image: "https://cdn.example/only.png",
      previous_response_id: "resp_prev",
    }, { directory: dir })
    await hooks.tool.luna_image.execute({
      prompt: "four refs",
      image: [
        "https://cdn.example/1.png",
        "https://cdn.example/2.png",
        "https://cdn.example/3.png",
        "https://cdn.example/4.png",
      ],
      edit: true,
    }, { directory: dir })
    await hooks.tool.luna_image.execute({ prompt: "empty array", image: [] }, { directory: dir })

    assert.equal(bodies[0].previous_response_id, "resp_prev")
    assert.equal("tool_choice" in bodies[0], false)
    assert.deepEqual(imageParts(bodies[0]), ["https://cdn.example/only.png"])
    assert.equal(bodies[1].tools[0].action, "edit")
    assert.equal(bodies[1].previous_response_id, undefined)
    assert.deepEqual(imageParts(bodies[1]), [
      "https://cdn.example/1.png",
      "https://cdn.example/2.png",
      "https://cdn.example/3.png",
      "https://cdn.example/4.png",
    ])
    assert.equal(bodies[1].input[0].content[0].type, "input_text")
    assert.equal(bodies[2].input, "empty array")
  })
})

function imageParts(body) {
  return body.input[0].content
    .filter((part) => part.type === "input_image")
    .map((part) => part.image_url)
}
