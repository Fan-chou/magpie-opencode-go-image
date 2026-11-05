/** OpenCode Go still-image model ids. The wire id always keeps the opencode-go/ prefix. */

export const LUNA_MODEL = "opencode-go/gpt-6-luna"
export const LUNA_ALT_MODEL = "opencode-go/gpt-5.6-luna"
export const GROK_MODEL = "opencode-go/grok-4.7"
export const LUNA_MODELS = [LUNA_MODEL, LUNA_ALT_MODEL]

export const DEFAULT_BASE_URL = "http://127.0.0.1:3425"
export const DEFAULT_TIMEOUT_MS = 120_000
export const MAX_TIMEOUT_MS = 600_000

/** Reference images larger than this are refused before the request is sent. */
export const MAX_IMAGE_BYTES = 20_000_000

export function isLunaModel(model) {
  return LUNA_MODELS.includes(model)
}

/**
 * Default and the two allowed Luna ids. A bare id is prefixed with opencode-go/.
 * Anything else throws before a request is built.
 */
export function normalizeLunaModel(value) {
  if (value == null || (typeof value === "string" && value.trim() === "")) return LUNA_MODEL
  if (typeof value !== "string") throw new Error("model is a string")
  const text = value.trim()
  const id = text.startsWith("opencode-go/") ? text : `opencode-go/${text}`
  if (id === LUNA_MODEL || id === LUNA_ALT_MODEL) return id
  throw new Error(`Luna model is not allowed: ${text}`)
}
