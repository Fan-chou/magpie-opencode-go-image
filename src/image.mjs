/**
 * Sniff still-image bytes. GIF is recognized and never treated as a savable still.
 * PNG size comes from IHDR. JPEG size comes from the first SOF. WEBP is a still
 * when the RIFF header says WEBP.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function sniffImage(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? [])
  if (buf.length < 8) return null
  if (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a") {
    const width = buf.length >= 8 ? buf.readUInt16LE(6) : 0
    const height = buf.length >= 10 ? buf.readUInt16LE(8) : 0
    return { ext: "gif", mime: "image/gif", width, height, gif: true }
  }
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_MAGIC) && buf.subarray(12, 16).toString("ascii") === "IHDR") {
    return {
      ext: "png",
      mime: "image/png",
      width: buf.readUInt32BE(16),
      height: buf.readUInt32BE(20),
      gif: false,
    }
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const size = jpegSize(buf)
    if (!size) return null
    return { ext: "jpg", mime: "image/jpeg", width: size.width, height: size.height, gif: false }
  }
  const webp = webpSize(buf)
  if (webp) return { ext: "webp", mime: "image/webp", width: webp.width, height: webp.height, gif: false }
  return null
}

export function formatLabel(ext) {
  if (ext === "png") return "PNG"
  if (ext === "jpg" || ext === "jpeg") return "JPEG"
  if (ext === "webp") return "WEBP"
  return String(ext || "").toUpperCase()
}

/**
 * data:image/... URL → bytes, or { gif: true } for image/gif.
 * Returns null when the URL is not a data URL we can decode.
 */
export function decodeDataUrl(value) {
  const match = /^data:([^;,]+)?((?:;[^,]*)*),([\s\S]*)$/i.exec(String(value ?? "").trim())
  if (!match) return null
  const mime = (match[1] || "").toLowerCase()
  if (mime === "image/gif") return { gif: true }
  const payload = (match[3] || "").replace(/\s+/g, "")
  if (!payload) return null
  const bytes = Buffer.from(payload, "base64")
  if (!bytes.length) return null
  return { bytes, mime }
}

export function looksLikeBase64(value) {
  const text = String(value ?? "").replace(/\s+/g, "")
  if (text.length < 16 || text.length % 4 !== 0) return false
  return /^[A-Za-z0-9+/]+={0,2}$/.test(text)
}

function jpegSize(buf) {
  let i = 2
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2
      continue
    }
    if (i + 4 > buf.length) return null
    const length = buf.readUInt16BE(i + 2)
    if (length < 2) return null
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
    if (isSof && i + 9 <= buf.length) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) }
    }
    i += 2 + length
  }
  return null
}

function webpSize(buf) {
  if (buf.length < 16) return null
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") return null
  if (buf.subarray(8, 12).toString("ascii") !== "WEBP") return null
  const chunk = buf.subarray(12, 16).toString("ascii")
  if (chunk === "VP8 " && buf.length >= 30) {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  if (chunk === "VP8L" && buf.length >= 25) {
    const b = buf.readUInt32LE(21)
    return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
  }
  if (chunk === "VP8X" && buf.length >= 30) {
    const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16)
    const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16)
    return { width, height }
  }
  return { width: 0, height: 0 }
}
