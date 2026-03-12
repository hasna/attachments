import {
  S3Client as AWSS3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string; // for custom S3-compatible storage / localstack
}

const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5 MB
const PART_SIZE = 5 * 1024 * 1024; // 5 MB per part

export class S3Client {
  private client: AWSS3Client;
  private bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new AWSS3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
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
}
