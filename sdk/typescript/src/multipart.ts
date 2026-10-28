import { createHash } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import type { Readable } from "node:stream";
import { invalidRequest, ProviderError } from "./errors.ts";

export interface UploadedFile {
  /** Temporary file with the bytes. */
  path: string;
  filename: string | undefined;
  mediaType: string | undefined;
  bytes: number;
  sha256: string;
}

export interface ParseUploadOptions {
  /** The value of the request's Content-Type header. */
  contentType: string | undefined;
  /** Where to write the file part. */
  tempPath: string;
  /** Upper bound for the file; larger uploads get 413 `payload_too_large` with `params.max_bytes`. */
  maxBytes: number;
  /** Field name of the file part. Default `file`. */
  field?: string;
  /** After the limit is exceeded, how much more of the body is read and discarded before giving up. */
  drainLimitBytes?: number;
}

const MAX_HEADER_BYTES = 16 * 1024;

/**
 * Streams a `multipart/form-data` body, writing the `file` part to `tempPath` while hashing it. Other
 * parts are ignored. When the file exceeds `maxBytes`, the rest of the body is read and discarded (so the
 * client can finish sending and read the response) and a 413 is thrown.
 */
export async function parseUpload(body: Readable, options: ParseUploadOptions): Promise<UploadedFile> {
  const boundary = boundaryOf(options.contentType);
  const field = options.field ?? "file";
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const drainLimit = options.drainLimitBytes ?? options.maxBytes + 256 * 1024 * 1024;

  // Prepend CRLF so the first boundary looks like every other delimiter.
  let buffer: Buffer = Buffer.from("\r\n");
  let state: "preamble" | "headers" | "body" | "epilogue" = "preamble";
  let partIsFile = false;
  let filename: string | undefined;
  let mediaType: string | undefined;
  let found = false;
  let bytes = 0;
  let tooLarge = false;
  let drained = 0;
  const hash = createHash("sha256");
  let out: ReturnType<typeof createWriteStream> | undefined;
  let outError: Error | undefined;

  const write = async (chunk: Buffer) => {
    if (!partIsFile || chunk.length === 0) return;
    bytes += chunk.length;
    if (bytes > options.maxBytes) {
      tooLarge = true;
      return;
    }
    hash.update(chunk);
    if (!out) {
      out = createWriteStream(options.tempPath, { mode: 0o600 });
      out.on("error", (err) => (outError = err));
    }
    if (!out.write(chunk)) await new Promise<void>((r) => out!.once("drain", () => r()));
  };

  const fail = async (err: Error): Promise<never> => {
    out?.destroy();
    await fs.rm(options.tempPath, { force: true });
    throw err;
  };

  try {
    for await (const raw of body) {
      const chunk = raw as Buffer;
      if (tooLarge) {
        drained += chunk.length;
        if (drained > drainLimit) break;
        continue;
      }
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      for (;;) {
        if (state === "preamble") {
          const i = buffer.indexOf(delimiter);
          if (i < 0) {
            buffer = buffer.subarray(Math.max(0, buffer.length - delimiter.length));
            break;
          }
          buffer = buffer.subarray(i + delimiter.length);
          state = "headers";
          continue;
        }
        if (state === "headers") {
          if (buffer.length >= 2 && buffer[0] === 0x2d && buffer[1] === 0x2d) {
            state = "epilogue";
            continue;
          }
          const end = buffer.indexOf("\r\n\r\n");
          if (end < 0) {
            if (buffer.length > MAX_HEADER_BYTES) return await fail(invalidRequest("invalid_multipart", "multipart part headers are too long"));
            break;
          }
          const headerText = buffer.subarray(0, end).toString("utf8").replace(/^\r\n/, "");
          buffer = buffer.subarray(end + 4);
          const headers = parsePartHeaders(headerText);
          const disposition = headers.get("content-disposition") ?? "";
          const name = dispositionParam(disposition, "name");
          partIsFile = name === field && !found;
          if (partIsFile) {
            found = true;
            filename = dispositionParam(disposition, "filename");
            mediaType = headers.get("content-type");
          }
          state = "body";
          continue;
        }
        if (state === "body") {
          const i = buffer.indexOf(delimiter);
          if (i < 0) {
            const keep = delimiter.length - 1;
            if (buffer.length > keep) {
              await write(buffer.subarray(0, buffer.length - keep));
              buffer = buffer.subarray(buffer.length - keep);
            }
            break;
          }
          await write(buffer.subarray(0, i));
          buffer = buffer.subarray(i + delimiter.length);
          partIsFile = false;
          state = "headers";
          if (tooLarge) break;
          continue;
        }
        // Epilogue: ignore the rest.
        buffer = Buffer.alloc(0);
        break;
      }
    }
  } catch (err) {
    return await fail(err instanceof Error ? err : new Error(String(err)));
  }

  if (tooLarge) {
    return await fail(
      new ProviderError(413, "payload_too_large", `the file is larger than ${options.maxBytes} bytes`, {
        params: { max_bytes: options.maxBytes },
      }),
    );
  }
  if (!found) return await fail(invalidRequest("missing_file", `the multipart body has no "${field}" part`));
  if (state !== "epilogue") return await fail(invalidRequest("invalid_multipart", "the multipart body ended early"));
  if (!out) {
    // An empty file.
    await fs.writeFile(options.tempPath, Buffer.alloc(0), { mode: 0o600 });
  } else {
    await new Promise<void>((resolve, reject) => out!.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  if (outError) return await fail(outError);
  return { path: options.tempPath, filename, mediaType, bytes, sha256: hash.digest("hex") };
}

function boundaryOf(contentType: string | undefined): string {
  const m = /^multipart\/form-data\s*;(.*)$/i.exec(contentType ?? "");
  const b = m ? /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(m[1]!) : null;
  const boundary = b ? (b[1] ?? b[2]) : undefined;
  if (!boundary || boundary.length > 200) {
    throw invalidRequest("invalid_multipart", "uploads must be multipart/form-data with a boundary");
  }
  return boundary;
}

function parsePartHeaders(text: string): Map<string, string> {
  const headers = new Map<string, string>();
  for (const line of text.split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return headers;
}

function dispositionParam(disposition: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|;)\\s*${name}=(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\s]*))`, "i");
  const m = re.exec(disposition);
  if (!m) return undefined;
  return m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2];
}
