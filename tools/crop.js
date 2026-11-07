/* Trim uniform-colour rows off the bottom of a PNG.
 *
 * Output is re-encoded with the same colour type (RGBA, 8-bit) using zlib only,
 * so there is no image-library dependency.
 *
 * Usage: node tools/crop.js <file.png> [--from-top]
 */
const fs = require("fs");
const zlib = require("zlib");

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readChunks(buf) {
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ type, data });
    off += 12 + len;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Decode IDAT into rows. Supports bit depth 8, colour type 2 (RGB) or 6 (RGBA). */
function decode(chunks, w, h, bpp) {
  const raw = zlib.inflateSync(
    Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)),
  );
  const stride = w * bpp;
  const out = Buffer.alloc(stride * h);
  let pos = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[pos++];
    const row = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, y * stride + stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }
  return out;
}

function encode(rgba, w, h, bpp) {
  const stride = w * bpp;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = bpp === 4 ? 6 : 2; // RGBA or RGB
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crcTable = chunk.crcTable || (chunk.crcTable = (() => {
      const t = new Int32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
      }
      return t;
    })());
    let crc = -1;
    for (const b of td) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ -1) >>> 0, 0);
    return Buffer.concat([len, td, crcBuf]);
  };
  return Buffer.concat([
    SIG,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Is this row entirely one colour? Returns that colour or null. */
function uniformColour(row) {
  const c = [row[0], row[1], row[2]];
  for (let x = 3; x + 2 < row.length; x += 3) {
    if (row[x] !== c[0] || row[x + 1] !== c[1] || row[x + 2] !== c[2]) return null;
  }
  return c;
}

function crop(file, keep = 10) {
  const buf = fs.readFileSync(file);
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR").data;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const colourType = ihdr[9];
  if (ihdr[8] !== 8 || (colourType !== 2 && colourType !== 6)) {
    throw new Error(`unsupported PNG (bitDepth=${ihdr[8]}, colourType=${colourType})`);
  }
  const bpp = colourType === 6 ? 4 : 3;

  const rgba = decode(chunks, w, h, bpp);
  const stride = w * bpp;

  // Reference colour = the bottom row. Walk up while rows match it.
  const bg = uniformColour(rgba.subarray((h - 1) * stride, h * stride));
  if (!bg) return { cropped: false, h };

  let last = h - 1;
  while (last > 0) {
    const row = rgba.subarray((last - 1) * stride, last * stride);
    const c = uniformColour(row);
    if (!c || c[0] !== bg[0] || c[1] !== bg[1] || c[2] !== bg[2]) break;
    last--;
  }

  const newH = Math.min(h, last + keep);
  if (newH >= h) return { cropped: false, h };

  const out = encode(rgba.subarray(0, newH * stride), w, newH, bpp);
  fs.writeFileSync(file, out);
  return { cropped: true, from: h, to: newH };
}

if (require.main === module) {
  const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  for (const f of files) {
    try {
      const r = crop(f);
      console.log(r.cropped ? `cropped ${f}: ${r.from} -> ${r.to}px` : `unchanged ${f} (${r.h}px)`);
    } catch (err) {
      console.log(`FAIL ${f}: ${err.message}`);
    }
  }
}

module.exports = { crop };
