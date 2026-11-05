import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./models.mjs"

const OPTION_KEYS = ["baseUrl", "bearer", "apiKey", "outDir", "timeoutMs"]

/**
 * plugins.json hands options as the plugin function's second argument.
 * A direct call `plugin({ baseUrl })` still works for local checks.
 */
export function resolvePluginOptions(input, options) {
  if (options != null) return options
  if (isOptionBag(input)) return input
  return {}
}

function isOptionBag(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if ("client" in value || "directory" in value || "worktree" in value || "$" in value) return false
  return OPTION_KEYS.some((key) => key in value)
}

export function normalizeOptions(raw) {
  let bag = raw ?? {}
  if (typeof bag === "string") {
    try {
      bag = JSON.parse(bag)
    } catch {
      throw new Error("plugin options must be a JSON object")
    }
  }
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) {
    throw new Error("plugin options must be an object")
  }

  const baseUrl = explicitBaseUrl(bag.baseUrl)
  const bearer = secret(bag.bearer) || secret(bag.apiKey)
  const outDir = typeof bag.outDir === "string" ? bag.outDir.trim() : ""
  if (outDir.includes("\0")) throw new Error("outDir contains a NUL byte")

  return {
    baseUrl,
    bearer,
    outDir,
    timeoutMs: timeoutOf(bag.timeoutMs),
  }
}

/**
 * Gateway root for this call.
 * Non-empty option wins. Otherwise MAGPIE_ADDR, read now. Otherwise loopback :3425.
 * Nothing here is stored on the module. A later call sees a changed env.
 * Magpie itself still needs a restart or plugin-host reload before MAGPIE_ADDR changes.
 */
export function resolveGatewayBaseUrl(optionBaseUrl, env = process.env) {
  const override = typeof optionBaseUrl === "string" ? optionBaseUrl.trim() : ""
  if (override) return normalizeGatewayAddr(override)
  const fromEnv = env && typeof env.MAGPIE_ADDR === "string" ? env.MAGPIE_ADDR.trim() : ""
  if (fromEnv) return normalizeGatewayAddr(fromEnv)
  return DEFAULT_BASE_URL
}

function explicitBaseUrl(value) {
  if (typeof value !== "string") return ""
  const text = value.trim()
  if (!text) return ""
  return normalizeGatewayAddr(text)
}

export function normalizeGatewayAddr(raw) {
  const text = String(raw).trim()
  if (!text) throw new Error("gateway address is empty")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return normalizeBaseUrl(text)
  if (!text.includes(":")) throw new Error("gateway address must be host:port or an http(s) URL")
  return normalizeBaseUrl(`http://${text}`)
}

export function normalizeBaseUrl(raw) {
  let url
  try {
    url = new URL(String(raw).trim())
  } catch {
    throw new Error(`gateway address is not a URL: ${raw}`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("gateway address must be http or https")
  }
  if (url.username || url.password) {
    throw new Error("gateway address must not carry a username or password; set bearer or apiKey")
  }
  let path = url.pathname.replace(/\/+$/, "")
  if (path.endsWith("/v1")) path = path.slice(0, -3)
  if (path === "/") path = ""
  return `${url.origin}${path}`
}

function secret(value) {
  if (value == null || value === "") return ""
  if (typeof value !== "string") throw new Error("bearer and apiKey are strings")
  const token = value.trim()
  if (!token) return ""
  if (/[\r\n]/.test(token)) throw new Error("bearer contains a newline")
  return token
}

function timeoutOf(value) {
  if (value == null || value === "") return DEFAULT_TIMEOUT_MS
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1000) {
    throw new Error("timeoutMs must be an integer number of milliseconds, at least 1000")
  }
  if (n > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be at most ${MAX_TIMEOUT_MS}`)
  }
  return n
}
