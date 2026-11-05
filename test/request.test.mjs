import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildResponsesBody } from "../src/client.mjs"
import { GROK_MODEL, LUNA_MODEL } from "../src/models.mjs"
import { referenceToImageUrl, resolveImageGenRequest } from "../src/request.mjs"

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)
const JPEG = Buffer.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x05, 0x80, 0x05, 0x80, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xd9,
])
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(8)])

describe("buildResponsesBody", () => {
  it("keeps a string input when there is no reference", () => {
    const luna = buildResponsesBody({
      model: LUNA_MODEL,
      prompt: "red circle",
      previousResponseId: "resp_luna_dropped",
      tool: { type: "image_generation" },
    })
    assert.equal(luna.input, "red circle")
    assert.equal(luna.store, false)
    assert.equal(luna.previous_response_id, undefined)
    assert.deepEqual(luna.tool_choice, { type: "image_generation" })
    assert.deepEqual(luna.tools, [{ type: "image_generation" }])

    const grok = buildResponsesBody({ model: GROK_MODEL, prompt: "blue square" })
    assert.equal(grok.input, "blue square")
    assert.equal("tool_choice" in grok, false)
    assert.deepEqual(grok.tools, [{ type: "image_generation" }])
  })

  it("encodes a Luna edit reference with size and quality", () => {
    const imageUrl = `data:image/png;base64,${PNG.toString("base64")}`
    const body = buildResponsesBody({
      model: LUNA_MODEL,
      prompt: "make the circle blue",
      previousResponseId: "resp_should_not_be_sent",
      references: [imageUrl],
      tool: { type: "image_generation", action: "edit", size: "1024x1024", quality: "high" },
    })
    assert.equal(body.store, false)
    assert.equal(body.previous_response_id, undefined)
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
        { type: "input_text", text: "make the circle blue" },
        { type: "input_image", image_url: imageUrl },
      ],
    }])
  })

  it("encodes Grok with a reference image and no tool_choice", () => {
    const imageUrl = "data:image/png;base64,AAAAgifAAA=="
    const body = buildResponsesBody({
      model: GROK_MODEL,
      prompt: "add a hat",
      previousResponseId: "resp_prev",
      references: [imageUrl],
      tool: { type: "image_generation", size: "1024x1024", quality: "low" },
    })
    assert.equal("tool_choice" in body, false)
    assert.equal(body.previous_response_id, "resp_prev")
    assert.equal(body.store, false)
    assert.deepEqual(body.tools, [{ type: "image_generation", size: "1024x1024", quality: "low" }])
    assert.equal(body.input[0].content[0].text, "add a hat")
    assert.equal(body.input[0].content[1].image_url, imageUrl)
    assert.equal(JSON.stringify(body.tools).toLowerCase().includes("gif"), false)
  })

  it("places one input_image per reference, in order", () => {
    const urls = ["https://cdn.example/a.png", "https://cdn.example/b.png"]
    const body = buildResponsesBody({
      model: LUNA_MODEL,
      prompt: "two",
      references: urls,
      tool: { type: "image_generation" },
    })
    assert.deepEqual(inputImages(body), urls)
    assert.deepEqual(body.input[0].content[0], { type: "input_text", text: "two" })
  })

  it("rejects n, a non-edit action, 512x512, and a GIF reference", () => {
    assert.throws(
      () => buildResponsesBody({
        model: LUNA_MODEL,
        prompt: "x",
        tool: { type: "image_generation", n: 3 },
      }),
      /n is not supported/,
    )
    assert.throws(
      () => buildResponsesBody({
        model: GROK_MODEL,
        prompt: "x",
        tool: { size: "512x512" },
      }),
      /1024x1024/,
    )
    assert.throws(
      () => buildResponsesBody({
        model: GROK_MODEL,
        prompt: "x",
        references: ["https://cdn.example/a.png"],
        tool: { action: "edit" },
      }),
      /luna_image/,
    )
    assert.throws(
      () => buildResponsesBody({
        model: LUNA_MODEL,
        prompt: "x",
        references: ["data:image/gif;base64,R0lGODlh"],
        tool: { type: "image_generation" },
      }),
      /GIF/,
    )
    assert.throws(
      () => buildResponsesBody({ model: LUNA_MODEL, prompt: "draw a gif" }),
      /GIF/,
    )
  })
})

describe("resolveImageGenRequest", () => {
  it("drops Luna previous_response_id and rejects n", async () => {
    const request = await resolveImageGenRequest({
      model: LUNA_MODEL,
      args: { prompt: "circle", previous_response_id: "resp_nope" },
    })
    assert.equal(request.previousResponseId, undefined)
    assert.equal(request.references, undefined)
    assert.deepEqual(request.tool, { type: "image_generation" })
    const body = buildResponsesBody(request)
    assert.equal(body.previous_response_id, undefined)
    assert.equal(body.input, "circle")

    await assert.rejects(
      () => resolveImageGenRequest({ model: GROK_MODEL, args: { prompt: "x", n: 2 } }),
      /n is not supported/,
    )
    await assert.rejects(
      () => resolveImageGenRequest({ model: LUNA_MODEL, args: { prompt: "x", size: "512x512" } }),
      /1024x1024/,
    )
    await assert.rejects(
      () => resolveImageGenRequest({ model: LUNA_MODEL, args: { prompt: "x", quality: "medium" } }),
      /quality/,
    )
  })

  it("reads a path into a data URL and passes https through", async () => {
    let seen
    const request = await resolveImageGenRequest({
      model: LUNA_MODEL,
      args: { prompt: "recolor", image: "/pics/ref.png", edit: true, size: "1024x1024", quality: "high" },
      readFile: async (filePath) => {
        seen = filePath
        return PNG
      },
    })
    assert.equal(seen, "/pics/ref.png")
    assert.deepEqual(request.references, [`data:image/png;base64,${PNG.toString("base64")}`])
    assert.deepEqual(request.tool, {
      type: "image_generation",
      action: "edit",
      size: "1024x1024",
      quality: "high",
    })

    const grok = await resolveImageGenRequest({
      model: GROK_MODEL,
      args: {
        prompt: "hat",
        image: "https://cdn.example/cat.png",
        previous_response_id: "resp_prev",
        quality: "low",
      },
      readFile: async () => {
        throw new Error("https must not touch the filesystem")
      },
    })
    assert.deepEqual(grok.references, ["https://cdn.example/cat.png"])
    assert.equal(grok.previousResponseId, "resp_prev")
    assert.equal(grok.tool.action, undefined)
    assert.equal(grok.tool.quality, "low")
    const body = buildResponsesBody(grok)
    assert.equal("tool_choice" in body, false)
    assert.deepEqual(inputImages(body), ["https://cdn.example/cat.png"])
  })

  it("normalizes a string to one reference and an array of 2–4 to that many input_image parts", async () => {
    const stringRequest = await resolveImageGenRequest({
      model: LUNA_MODEL,
      args: { prompt: "one", image: "https://cdn.example/a.png" },
      readFile: async () => {
        throw new Error("https must not touch the filesystem")
      },
    })
    assert.deepEqual(stringRequest.references, ["https://cdn.example/a.png"])
    assert.deepEqual(inputImages(buildResponsesBody(stringRequest)), ["https://cdn.example/a.png"])

    const urls = [
      "https://cdn.example/a.png",
      "https://cdn.example/b.png",
      "https://cdn.example/c.png",
      `data:image/png;base64,${PNG.toString("base64")}`,
    ]
    for (const count of [2, 3, 4]) {
      const slice = urls.slice(0, count)
      const request = await resolveImageGenRequest({
        model: GROK_MODEL,
        args: { prompt: "combine", image: slice, previous_response_id: "resp_prev" },
        readFile: async () => {
          throw new Error("https and data URLs must not touch the filesystem")
        },
      })
      assert.deepEqual(request.references, slice)
      const body = buildResponsesBody(request)
      assert.equal(body.previous_response_id, "resp_prev")
      assert.equal("tool_choice" in body, false)
      assert.equal(body.store, false)
      assert.deepEqual(body.input[0].content[0], { type: "input_text", text: "combine" })
      assert.deepEqual(inputImages(body), slice)
      assert.equal(body.input[0].content.filter((part) => part.type === "input_image").length, count)
    }

    const edited = await resolveImageGenRequest({
      model: LUNA_MODEL,
      args: {
        prompt: "edit both",
        image: ["https://cdn.example/a.png", "https://cdn.example/b.png"],
        edit: true,
      },
    })
    assert.equal(edited.tool.action, "edit")
    assert.equal(edited.previousResponseId, undefined)
    const editedBody = buildResponsesBody(edited)
    assert.equal(editedBody.tools[0].action, "edit")
    assert.equal(editedBody.previous_response_id, undefined)
    assert.equal(inputImages(editedBody).length, 2)

    const seen = []
    const mixed = await resolveImageGenRequest({
      model: LUNA_MODEL,
      args: { prompt: "mixed", image: [" /pics/ref.png ", "https://cdn.example/b.png"] },
      readFile: async (filePath) => {
        seen.push(filePath)
        return PNG
      },
    })
    assert.deepEqual(seen, ["/pics/ref.png"])
    assert.deepEqual(inputImages(buildResponsesBody(mixed)), [
      `data:image/png;base64,${PNG.toString("base64")}`,
      "https://cdn.example/b.png",
    ])
  })

  it("rejects more than 4 references before reading files", async () => {
    let reads = 0
    await assert.rejects(
      () => resolveImageGenRequest({
        model: LUNA_MODEL,
        args: {
          prompt: "too many",
          image: ["/a.png", "/b.png", "/c.png", "/d.png", "/e.png"],
        },
        readFile: async () => {
          reads += 1
          return PNG
        },
      }),
      /at most 4/,
    )
    assert.equal(reads, 0)
    await assert.rejects(
      () => resolveImageGenRequest({
        model: GROK_MODEL,
        args: { prompt: "nope", image: { url: "https://cdn.example/a.png" } },
      }),
      /string or an array of strings/,
    )
  })

  it("treats an empty array as no reference", async () => {
    const request = await resolveImageGenRequest({
      model: LUNA_MODEL,
      args: { prompt: "plain", image: [] },
      readFile: async () => {
        throw new Error("an empty array must not touch the filesystem")
      },
    })
    assert.equal(request.references, undefined)
    assert.equal(buildResponsesBody(request).input, "plain")
    await assert.rejects(
      () => resolveImageGenRequest({
        model: LUNA_MODEL,
        args: { prompt: "edit", image: [], edit: true },
      }),
      /edit requires image/,
    )
  })
})

function inputImages(body) {
  return body.input[0].content
    .filter((part) => part.type === "input_image")
    .map((part) => part.image_url)
}

describe("referenceToImageUrl", () => {
  it("turns a PNG or JPEG path into a data URL via the injected reader", async () => {
    const readFile = async (filePath) => {
      assert.equal(filePath, "/tmp/ref.png")
      return PNG
    }
    const pngUrl = await referenceToImageUrl("/tmp/ref.png", { readFile })
    assert.equal(pngUrl, `data:image/png;base64,${PNG.toString("base64")}`)

    const jpegUrl = await referenceToImageUrl("/tmp/ref.jpg", {
      readFile: async () => JPEG,
    })
    assert.equal(jpegUrl, `data:image/jpeg;base64,${JPEG.toString("base64")}`)
  })

  it("passes https and an existing PNG data URL through", async () => {
    let calls = 0
    const readFile = async () => {
      calls += 1
      return PNG
    }
    assert.equal(
      await referenceToImageUrl("https://cdn.example/cat.png", { readFile }),
      "https://cdn.example/cat.png",
    )
    const dataUrl = `data:image/png;base64,${PNG.toString("base64")}`
    assert.equal(await referenceToImageUrl(dataUrl, { readFile }), dataUrl)
    assert.equal(calls, 0)
    await assert.rejects(() => referenceToImageUrl("http://cdn.example/a.png"), /https/)
  })

  it("refuses GIF bytes from a path and from a data URL", async () => {
    await assert.rejects(
      () => referenceToImageUrl("/tmp/anim.gif", { readFile: async () => GIF }),
      /GIF/,
    )
    await assert.rejects(
      () => referenceToImageUrl(
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      ),
      /GIF/,
    )
    await assert.rejects(
      () => referenceToImageUrl(
        "data:image/png;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
      ),
      /GIF/,
    )
  })
})
