// Detects an all-black PNG: some upstreams replace a filtered image with one and report success
// (v1.md section 3.10). Only 8-bit, non-interlaced PNGs are decoded; anything else is not judged.

import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/** True for a decodable PNG whose every pixel is black (colour channels 0, any alpha). */
export function isBlackPng(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 33 || !b.subarray(0, 8).equals(SIGNATURE)) return false;
  let width = 0;
  let height = 0;
  let colourType = -1;
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= b.length; ) {
    const length = b.readUInt32BE(offset);
    const type = b.toString("latin1", offset + 4, offset + 8);
    const data = b.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      colourType = data[9]!;
      if (depth !== 8 || data[12] !== 0 || CHANNELS[colourType] === undefined) return false;
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = CHANNELS[colourType];
  if (!channels || width === 0 || height === 0 || width * height > 64_000_000) return false;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return false;
  }
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) return false;
  // Colour channels: gray (types 0 and 4) or RGB (types 2 and 6); alpha is not looked at.
  const colour = colourType === 0 || colourType === 4 ? 1 : 3;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels]! : 0;
      const up = previous[x]!;
      const c = x >= channels ? previous[x - channels]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      } else if (filter !== 0) return false;
      line[x] = v & 0xff;
      if (x % channels < colour && line[x] !== 0) return false;
    }
    previous = line;
  }
  return true;
}
