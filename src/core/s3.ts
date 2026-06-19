import {
  S3Client as AWSS3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createReadStream, createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  endpoint?: string; // for custom S3-compatible storage / localstack
}

const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5 MB
const PART_SIZE = 5 * 1024 * 1024; // 5 MB per part
const MANAGED_UPLOAD_PART_SIZE = 64 * 1024 * 1024;
const MANAGED_UPLOAD_QUEUE_SIZE = 4;

export interface S3StreamResult {
  body: Readable | ReadableStream<Uint8Array>;
  contentLength?: number;
  contentRange?: string;
  contentType?: string;
  status: 200 | 206;
}

export interface S3ObjectInfo {
  contentLength?: number;
  contentType?: string;
}

export interface S3UploadOptions {
  transform?: (stream: NodeJS.ReadableStream) => NodeJS.ReadableStream;
}

function toNodeReadable(body: unknown): Readable {
  if (body && typeof (body as Readable).pipe === "function") return body as Readable;
  if (body && typeof (body as { transformToWebStream?: () => ReadableStream<Uint8Array> }).transformToWebStream === "function") {
    return Readable.fromWeb((body as { transformToWebStream: () => ReadableStream<Uint8Array> }).transformToWebStream() as never);
  }
  if (body && Symbol.asyncIterator in Object(body)) {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  throw new Error("Unsupported S3 response body stream");
}

export class S3Client {
  private client: AWSS3Client;
  private bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new AWSS3Client({
      region: config.region,
      ...(config.accessKeyId && config.secretAccessKey
        ? {
            credentials: {
              accessKeyId: config.accessKeyId,
              secretAccessKey: config.secretAccessKey,
            },
          }
        : {}),
      ...(config.endpoint !== undefined ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    });
  }

  async upload(key: string, body: Buffer | Uint8Array, contentType: string): Promise<void> {
    if (body.length > MULTIPART_THRESHOLD) {
      await this.uploadMultipart(key, body, contentType);
    } else {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        })
      );
    }
  }

  async uploadFile(key: string, filePath: string, contentType: string, options: S3UploadOptions = {}): Promise<void> {
    const input = createReadStream(filePath);
    const stream = options.transform ? options.transform(input) : input;
    await this.uploadStream(key, stream, contentType);
  }

  async uploadStream(
    key: string,
    stream: NodeJS.ReadableStream,
    contentType: string
  ): Promise<void> {
    await this.uploadMultipartStream(key, stream, contentType);
  }

  private async uploadMultipart(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string
  ): Promise<void> {
    const createResp = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      })
    );

    const uploadId = createResp.UploadId;
    if (!uploadId) {
      throw new Error("Failed to initiate multipart upload: no UploadId returned");
    }

    const parts: { ETag: string; PartNumber: number }[] = [];
    let partNumber = 1;

    for (let offset = 0; offset < body.length; offset += PART_SIZE) {
      const chunk = body.slice(offset, offset + PART_SIZE);
      const partResp = await this.client.send(
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: chunk,
        })
      );

      const etag = partResp.ETag;
      if (!etag) {
        throw new Error(`Missing ETag for part ${partNumber}`);
      }

      parts.push({ ETag: etag, PartNumber: partNumber });
      partNumber++;
    }

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: parts },
      })
    );
  }

  private async uploadMultipartStream(
    key: string,
    stream: NodeJS.ReadableStream,
    contentType: string
  ): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: stream as never,
        ContentType: contentType,
      },
      queueSize: MANAGED_UPLOAD_QUEUE_SIZE,
      partSize: MANAGED_UPLOAD_PART_SIZE,
      leavePartsOnError: false,
    });
    await upload.done();
  }

  private async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Buffer | Uint8Array
  ): Promise<string> {
    const partResp = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
      })
    );

    const etag = partResp.ETag;
    if (!etag) {
      throw new Error(`Missing ETag for part ${partNumber}`);
    }
    return etag;
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        })
      );
    } catch {
      // Best-effort cleanup. The original upload failure is more useful.
    }
  }

  async createMultipartUpload(key: string, contentType: string): Promise<string> {
    const resp = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      })
    );
    if (!resp.UploadId) {
      throw new Error("Failed to initiate multipart upload: no UploadId returned");
    }
    return resp.UploadId;
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresIn: number
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: { ETag: string; PartNumber: number }[]
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: [...parts].sort((a, b) => a.PartNumber - b.PartNumber),
        },
      })
    );
  }

  async head(key: string): Promise<S3ObjectInfo> {
    const resp = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
    return {
      contentLength: resp.ContentLength,
      contentType: resp.ContentType,
    };
  }

  async download(key: string): Promise<Buffer> {
    const resp = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );

    if (!resp.Body) {
      throw new Error(`No body returned for key: ${key}`);
    }

    const bytes = await resp.Body.transformToByteArray();
    return Buffer.from(bytes);
  }

  async downloadStream(key: string, range?: string): Promise<S3StreamResult> {
    const resp = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range ? { Range: range } : {}),
      })
    );

    if (!resp.Body) {
      throw new Error(`No body returned for key: ${key}`);
    }

    return {
      body: toNodeReadable(resp.Body),
      contentLength: resp.ContentLength,
      contentRange: resp.ContentRange,
      contentType: resp.ContentType,
      status: resp.ContentRange ? 206 : 200,
    };
  }

  async downloadToFile(key: string, path: string): Promise<number> {
    const result = await this.downloadStream(key);
    await pipeline(toNodeReadable(result.body), createWriteStream(path));
    return result.contentLength ?? 0;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }

  async presign(key: string, expiresIn: number): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }

  async presignPut(key: string, contentType: string, expiresIn: number): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }
}
