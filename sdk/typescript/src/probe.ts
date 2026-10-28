import { promises as fs } from "node:fs";
import type { ArtifactMetadata } from "./types.ts";
import { normalizeMediaType } from "./media.ts";

/** Reads `width` and `height` from a PNG header. */
export function pngMetadata(b: Uint8Array): ArtifactMetadata | undefined {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[12] !== 0x49 || b[13] !== 0x48) return undefined;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Offset of the PCM data in the file. */
  dataOffset: number;
  /** Size of the data chunk as declared in the header. */
  declaredDataBytes: number;
  /** Data bytes present in the given buffer (at most the declared size). */
  dataBytes: number;
  durationMs: number;
  /** RIFF LIST/INFO entries, for example `ICMT` (comment). */
  info: Record<string, string>;
}

/** Parses a PCM WAV header: format, duration and LIST/INFO entries. `undefined` when not a WAV. */
export function parseWav(b: Uint8Array): WavInfo | undefined {
  const ascii = (o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));
  if (b.length < 12 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE") return undefined;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let byteRate = 0;
  let dataBytes: number | undefined;
  let dataOffset = 0;
  let declaredDataBytes = 0;
  const info: Record<string, string> = {};
  while (offset + 8 <= b.length) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= b.length) {
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      byteRate = view.getUint32(body + 8, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === "LIST" && body + 4 <= b.length && ascii(body, 4) === "INFO") {
      let o = body + 4;
      const end = Math.min(body + size, b.length);
      while (o + 8 <= end) {
        const key = ascii(o, 4);
        const len = view.getUint32(o + 4, true);
        const raw = b.subarray(o + 8, Math.min(o + 8 + len, end));
        info[key] = new TextDecoder().decode(raw).replace(/\0+$/, "");
        o += 8 + len + (len % 2);
      }
    } else if (id === "data") {
      dataOffset = body;
      declaredDataBytes = size;
      dataBytes = Math.min(size, b.length - body);
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!sampleRate || !byteRate || dataBytes === undefined) return undefined;
  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataOffset,
    declaredDataBytes,
    dataBytes,
    durationMs: Math.round((dataBytes / byteRate) * 1000),
    info,
  };
}

/**
 * Best-effort metadata for stored media: PNG size, WAV duration and sample rate. Reads the header of a
 * file (and the size, for WAV durations).
 */
export async function probeFileMetadata(file: string, mediaType: string): Promise<ArtifactMetadata | undefined> {
  const type = normalizeMediaType(mediaType);
  if (type !== "image/png" && type !== "audio/wav") return undefined;
  const handle = await fs.open(file, "r");
  try {
    const head = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const bytes = head.subarray(0, bytesRead);
    if (type === "image/png") return pngMetadata(bytes);
    const wav = parseWav(bytes);
    if (!wav) return undefined;
    // The header may claim more than the file holds; use what is there.
    const { size } = await handle.stat();
    const dataBytes = Math.max(0, Math.min(wav.declaredDataBytes, size - wav.dataOffset));
    const byteRate = (wav.sampleRate * wav.channels * wav.bitsPerSample) / 8 || 1;
    return { duration_ms: Math.round((dataBytes / byteRate) * 1000), sample_rate: wav.sampleRate };
  } finally {
    await handle.close();
  }
}

/** Same as `probeFileMetadata` for bytes in memory. */
export function probeMetadata(bytes: Uint8Array, mediaType: string): ArtifactMetadata | undefined {
  const type = normalizeMediaType(mediaType);
  if (type === "image/png") return pngMetadata(bytes);
  if (type === "audio/wav") {
    const wav = parseWav(bytes);
    return wav ? { duration_ms: wav.durationMs, sample_rate: wav.sampleRate } : undefined;
  }
  return undefined;
}
