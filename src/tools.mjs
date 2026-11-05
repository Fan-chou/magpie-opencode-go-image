import { generateImage } from "./generate.mjs"
import { GROK_MODEL, LUNA_ALT_MODEL, LUNA_MODEL, normalizeLunaModel } from "./models.mjs"
import { normalizeOptions, resolvePluginOptions } from "./options.mjs"
import { IMAGE_QUALITIES, IMAGE_SIZE, MAX_REFERENCE_IMAGES } from "./request.mjs"

const LUNA_DESCRIPTION =
  "Generate a still image with an OpenCode Go Luna model through Magpie's local gateway. " +
  "Default model is opencode-go/gpt-6-luna. Optional model is gpt-5.6-luna or opencode-go/gpt-5.6-luna; a bare id is sent as opencode-go/<id>. Any other model id is an error. " +
  "POST {baseUrl}/v1/responses with tools [{type:image_generation}], tool_choice {type:image_generation}, and store false. " +
  `Optional image is one reference or up to ${MAX_REFERENCE_IMAGES}: a string, or a string array of local paths, https URLs, or data:image PNG/JPEG. A string is one reference. An empty array matches omitting image. With references, input is one input_text plus one input_image per reference, in array order; without them, input stays the prompt string. ` +
  "edit true with image sets tools[0].action to edit. size, when set, is 1024x1024. quality is low or high. " +
  "baseUrl is resolved on every call: a non-empty plugin option baseUrl, otherwise MAGPIE_ADDR (host:port or an http URL), otherwise http://127.0.0.1:3425. A local Magpie on that default needs no options. " +
  "The call is not /v1/images/generations and does not ask for GIF (that API returns 400 GIF output is not enabled). " +
  "There is no previous_response_id and no batch count n. store stays false. " +
  "Loopback needs no Authorization; bearer or apiKey in plugin options is only for a gateway off loopback. " +
  "Billing is the Magpie OpenCode Go allowance. The file is a PNG, typically about 1254×1254, written to disk. " +
  "Returns JSON: path (absolute), paths, note (format, pixel size, bytes, milliseconds), response_id, model (the opencode-go/ id that was sent), mime, width, height, bytes, ms. " +
  "prompt is the picture. out_dir overrides the plugin outDir for this call."

const GROK_DESCRIPTION =
  "Generate or edit a still image with OpenCode Go model opencode-go/grok-4.7 through Magpie's local gateway. " +
  "POST {baseUrl}/v1/responses with tools [{type:image_generation}] and store false. " +
  `Optional image is one reference or up to ${MAX_REFERENCE_IMAGES}: a string, or a string array of local paths, https URLs, or data:image PNG/JPEG. A string is one reference. An empty array matches omitting image. Grok requires both width and height of each reference to be at least 8 px. ` +
  "With references, input is one input_text plus one input_image per reference, in array order; without them, input stays the prompt string. size, when set, is 1024x1024. quality is low or high. " +
  "baseUrl is resolved on every call: a non-empty plugin option baseUrl, otherwise MAGPIE_ADDR (host:port or an http URL), otherwise http://127.0.0.1:3425. A local Magpie on that default needs no options. " +
  "The request omits tool_choice. Magpie returns HTTP 422 Endpoint is unavailable when tool_choice is sent for this model. " +
  "The call is not /v1/images/generations and does not ask for GIF. There is no batch count n. " +
  "The file is a JPEG, typically about 1408×1408, written to disk. " +
  "Pass previous_response_id from an earlier grok_image result to edit that image; prompt is then the edit instruction. image does not replace previous_response_id. " +
  "Returns JSON: path (absolute), paths, note (format, pixel size, bytes, milliseconds), response_id (pass this to the next edit), model, mime, width, height, bytes, ms. " +
  "Billing is the Magpie OpenCode Go allowance. Loopback needs no Authorization."

const promptArg = {
  type: "string",
  minLength: 1,
  description: "Picture to draw. With grok_image previous_response_id, this is the edit instruction.",
}

const outDirArg = {
  type: "string",
  description: "Directory for this file. An absolute path is used as given. A relative path is resolved from the agent directory. Overrides plugin option outDir.",
}

const imageArg = {
  type: ["string", "array"],
  items: { type: "string" },
  maxItems: MAX_REFERENCE_IMAGES,
  description:
    `Optional reference image, or up to ${MAX_REFERENCE_IMAGES} references. Pass a string, or an array of strings. A string is one reference. ` +
    "Each item is a local filesystem path, an https:// URL, or a data:image/png or data:image/jpeg base64 URL. " +
    "A local file is read and sent as data:image/...;base64,... after a PNG or JPEG sniff. GIF is refused. http:// is refused. " +
    `An empty array is the same as omitting image. More than ${MAX_REFERENCE_IMAGES} is an error before any file is read and before the request is sent. ` +
    "Grok requires both width and height of each reference to be at least 8 px.",
}

const sizeArg = {
  type: "string",
  enum: [IMAGE_SIZE],
  description: `Passed as tools[0].size. The only accepted value is ${IMAGE_SIZE}.`,
}

const qualityArg = {
  type: "string",
  enum: IMAGE_QUALITIES,
  description: "Passed as tools[0].quality. low or high.",
}

const editArg = {
  type: "boolean",
  description: "When true and at least one image is set, tools[0].action is edit. Omit or false to leave action unset. Luna only.",
}

export function createTools(input, options) {
  const cfg = normalizeOptions(resolvePluginOptions(input, options))
  return {
    luna_image: {
      description: LUNA_DESCRIPTION,
      args: {
        type: "object",
        properties: {
          prompt: promptArg,
          model: {
            type: "string",
            enum: [LUNA_MODEL, "gpt-6-luna", LUNA_ALT_MODEL, "gpt-5.6-luna"],
            description:
              "Luna model. Default opencode-go/gpt-6-luna. Also gpt-5.6-luna or opencode-go/gpt-5.6-luna. Bare ids are prefixed with opencode-go/ before the request. Any other id is rejected.",
          },
          image: imageArg,
          edit: editArg,
          size: sizeArg,
          quality: qualityArg,
          out_dir: outDirArg,
        },
        required: ["prompt"],
      },
      async execute(args, ctx) {
        return generateImage({ cfg, model: normalizeLunaModel(args?.model), args, ctx })
      },
    },
    grok_image: {
      description: GROK_DESCRIPTION,
      args: {
        type: "object",
        properties: {
          prompt: promptArg,
          image: imageArg,
          size: sizeArg,
          quality: qualityArg,
          out_dir: outDirArg,
          previous_response_id: {
            type: "string",
            description: "response_id from an earlier grok_image call. Magpie continues that image and applies prompt as the edit.",
          },
        },
        required: ["prompt"],
      },
      async execute(args, ctx) {
        return generateImage({ cfg, model: GROK_MODEL, args, ctx })
      },
    },
  }
}
