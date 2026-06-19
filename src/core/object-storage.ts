import { createReadStream, createWriteStream, mkdirSync, statSync, unlinkSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { pipeline } from "stream/promises";
import type { Readable } from "stream";
import { S3Client } from "./s3";
import type { AttachmentsConfig } from "./config";
import { resolveStorageBackend } from "./config";

export interface ByteRange {
  start: number;
  end?: number;
}

export interface ObjectStreamResult {
  body: Readable | ReadableStream<Uint8Array>;
  contentLength?: number;
  contentRange?: string;
  contentType?: string;
  status: 200 | 206;
}

export interface UploadObjectOptions {
  transform?: (stream: NodeJS.ReadableStream) => NodeJS.ReadableStream;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveLocalObjectPath(config: AttachmentsConfig, key: string): string {
  return join(expandHome(config.storage.localDir), key);
}

export function parseRangeHeader(rangeHeader: string | null | undefined, size: number): ByteRange | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (!startRaw && !endRaw) return null;

  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(size - suffix, 0), end: size - 1 };
  }

  const start = Number(startRaw);
  const end = endRaw ? Number(endRaw) : undefined;
  if (!Number.isInteger(start) || start < 0) return null;
  if (end !== undefined && (!Number.isInteger(end) || end < start)) return null;
  if (start >= size) return null;
  return { start, end: end !== undefined ? Math.min(end, size - 1) : undefined };
}

export class LocalObjectStore {
  constructor(private config: AttachmentsConfig) {}

  async uploadFile(key: string, filePath: string, _contentType: string, options: UploadObjectOptions = {}): Promise<void> {
    const dest = resolveLocalObjectPath(this.config, key);
    mkdirSync(dirname(dest), { recursive: true });
    const input = createReadStream(filePath);
    const source = options.transform ? options.transform(input) : input;
    await pipeline(source, createWriteStream(dest));
  }

  async uploadStream(key: string, stream: NodeJS.ReadableStream, _contentType: string, options: UploadObjectOptions = {}): Promise<void> {
    const dest = resolveLocalObjectPath(this.config, key);
    mkdirSync(dirname(dest), { recursive: true });
    const source = options.transform ? options.transform(stream) : stream;
    await pipeline(source, createWriteStream(dest));
  }

  async uploadBuffer(key: string, body: Buffer | Uint8Array, _contentType: string): Promise<void> {
    const dest = resolveLocalObjectPath(this.config, key);
    mkdirSync(dirname(dest), { recursive: true });
    await Bun.write(dest, body);
  }

  getStream(key: string, contentType: string, range?: ByteRange | null): ObjectStreamResult {
    const path = resolveLocalObjectPath(this.config, key);
    const size = statSync(path).size;
    if (range) {
      const end = range.end ?? size - 1;
      return {
        body: createReadStream(path, { start: range.start, end }),
        contentLength: end - range.start + 1,
        contentRange: `bytes ${range.start}-${end}/${size}`,
        contentType,
        status: 206,
      };
    }
    return {
      body: createReadStream(path),
      contentLength: size,
      contentType,
      status: 200,
    };
  }

  async downloadToFile(key: string, destPath: string): Promise<number> {
    mkdirSync(dirname(destPath), { recursive: true });
    const source = createReadStream(resolveLocalObjectPath(this.config, key));
    await pipeline(source, createWriteStream(destPath));
    return statSync(destPath).size;
  }

  async delete(key: string): Promise<void> {
    try {
      unlinkSync(resolveLocalObjectPath(this.config, key));
    } catch {
      // Missing local objects are ignored for metadata cleanup parity with S3.
    }
  }
}

export function createObjectStore(config: AttachmentsConfig): LocalObjectStore | S3Client {
  const backend = resolveStorageBackend(config);
  return backend === "s3" ? new S3Client(config.s3) : new LocalObjectStore(config);
}
