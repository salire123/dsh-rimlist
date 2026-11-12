/**
 * Minimal archive helpers (no deps): gunzip text and read entries from a ZIP
 * (stored / deflate only — what GitHub "archive/refs/heads/x.zip" produces).
 */
import { gunzipSync, inflateRawSync } from 'node:zlib'

export const isGzip = (buf) => buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b
export const isZip = (buf) => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04

export const gunzipText = (buf) => gunzipSync(buf).toString('utf8')

/** List zip entries: [{ name, read(): Buffer }]. Uses the central directory. */
export function zipEntries(buf) {
  // Locate End Of Central Directory.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file (no EOCD)')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory')
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const usize = buf.readUInt32LE(off + 24)
    const nlen = buf.readUInt16LE(off + 28)
    const xlen = buf.readUInt16LE(off + 30)
    const clen = buf.readUInt16LE(off + 32)
    const lho = buf.readUInt32LE(off + 42)
    const name = buf.toString('utf8', off + 46, off + 46 + nlen)
    out.push({
      name,
      size: usize,
      read: () => {
        const ln = buf.readUInt16LE(lho + 26)
        const lx = buf.readUInt16LE(lho + 28)
        const start = lho + 30 + ln + lx
        const data = buf.subarray(start, start + csize)
        if (method === 0) return Buffer.from(data)
        if (method === 8) return inflateRawSync(data)
        throw new Error('unsupported zip compression method ' + method + ' for ' + name)
      },
    })
    off += 46 + nlen + xlen + clen
  }
  return out
}

/** Find the first zip entry whose path ends with `suffix` (ignoring the top-level folder). */
export function zipFind(buf, suffix) {
  const entries = zipEntries(buf)
  const hit = entries.find((e) => e.name.endsWith(suffix) && !e.name.endsWith('/'))
  return hit ? hit.read() : null
}
