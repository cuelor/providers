/** Common aliases mapped to the canonical MIME type. */
export const MIME_ALIASES: Readonly<Record<string, string>> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-pn-wav": "audio/wav",
  "audio/mp3": "audio/mpeg",
  "audio/x-mp3": "audio/mpeg",
  "audio/mpeg3": "audio/mpeg",
  "audio/x-mpeg": "audio/mpeg",
  "audio/x-m4a": "audio/mp4",
  "audio/m4a": "audio/mp4",
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "video/x-m4v": "video/mp4",
};

const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;

/** Whether `value` is a MIME type without parameters, as `common.json#/$defs/media_type`. */
export function isValidMediaType(value: string): boolean {
  return MEDIA_TYPE.test(value);
}

/** Lowercases, drops parameters (`; charset=…`) and maps aliases. */
export function normalizeMediaType(value: string): string {
  const base = value.split(";")[0]!.trim().toLowerCase();
  return MIME_ALIASES[base] ?? base;
}

/** `image`, `video`, `audio`, … : the top-level type. */
export function topLevelType(mediaType: string): string {
  return normalizeMediaType(mediaType).split("/")[0] ?? "";
}

/**
 * Identifies common media from the file header. Returns `undefined` when unknown. Used to check that
 * outputs are what they claim to be.
 */
export function sniffMediaType(bytes: Uint8Array): string | undefined {
  const b = bytes;
  const ascii = (start: number, text: string) => {
    if (b.length < start + text.length) return false;
    for (let i = 0; i < text.length; i++) if (b[start + i] !== text.charCodeAt(i)) return false;
    return true;
  };
  if (b.length >= 8 && b[0] === 0x89 && ascii(1, "PNG\r\n\x1a\n")) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(0, "RIFF") && ascii(8, "WAVE")) return "audio/wav";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(4, "ftyp")) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (brand === "qt  ") return "video/quicktime";
    if (brand.startsWith("M4A")) return "audio/mp4";
    return "video/mp4";
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (ascii(0, "ID3")) return "audio/mpeg";
  if (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) return "audio/mpeg";
  if (ascii(0, "OggS")) return "audio/ogg";
  if (ascii(0, "fLaC")) return "audio/flac";
  return undefined;
}
