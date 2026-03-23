import fs from "node:fs";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "./env.js";

const s3KeyPrefix = normalizePrefix(env.S3_KEY_PREFIX || "");
let s3Client: S3Client | null | undefined;

export function isS3StorageEnabled() {
  return env.STORAGE_PROVIDER === "s3";
}

export async function uploadFileToObjectStorage(
  namespace: string,
  objectKey: string,
  absoluteFilePath: string,
  contentType?: string,
) {
  const client = getS3Client();
  if (!client) return;

  const key = resolveS3Key(namespace, objectKey);
  const baseMeta = {
    bucket: env.CORE_S3_BUCKET,
    key,
    absoluteFilePath,
    contentType: contentType || null,
  };
  let sizeBytes = 0;

  try {
    const stat = await fs.promises.stat(absoluteFilePath);
    sizeBytes = stat.size;
  } catch (error) {
    console.error("[core:s3] put_object:failed", { ...baseMeta, error });
    throw error;
  }

  const meta = {
    ...baseMeta,
    sizeBytes,
  };

  console.info("[core:s3] put_object:start", meta);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: env.CORE_S3_BUCKET,
        Key: key,
        Body: fs.createReadStream(absoluteFilePath),
        ContentType: contentType,
      }),
    );
    console.info("[core:s3] put_object:success", meta);
  } catch (error) {
    console.error("[core:s3] put_object:failed", { ...meta, error });
    throw error;
  }
}

export async function uploadBufferToObjectStorage(
  namespace: string,
  objectKey: string,
  body: Buffer,
  contentType?: string,
) {
  const client = getS3Client();
  if (!client) return;

  const key = resolveS3Key(namespace, objectKey);
  const meta = {
    bucket: env.CORE_S3_BUCKET,
    key,
    contentType: contentType || null,
    sizeBytes: body.length,
  };

  console.info("[core:s3] put_object:start", meta);
  try {
    await client.send(
      new PutObjectCommand({
        Bucket: env.CORE_S3_BUCKET,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
    console.info("[core:s3] put_object:success", meta);
  } catch (error) {
    console.error("[core:s3] put_object:failed", { ...meta, error });
    throw error;
  }
}

export async function getObjectStreamFromStorage(
  namespace: string,
  objectKey: string,
): Promise<Readable | null> {
  const client = getS3Client();
  if (!client) return null;
  try {
    const result = await client.send(
      new GetObjectCommand({
        Bucket: env.CORE_S3_BUCKET,
        Key: resolveS3Key(namespace, objectKey),
      }),
    );
    return toReadable(result.Body);
  } catch (error) {
    if (isS3NotFound(error)) return null;
    throw error;
  }
}

export async function deleteObjectFromStorage(namespace: string, objectKey: string) {
  const client = getS3Client();
  if (!client) return;
  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: env.CORE_S3_BUCKET,
        Key: resolveS3Key(namespace, objectKey),
      }),
    );
  } catch (error) {
    if (!isS3NotFound(error)) throw error;
  }
}

function resolveS3Key(namespace: string, objectKey: string) {
  const cleanNamespace = normalizePrefix(namespace);
  const cleanObjectKey = String(objectKey || "").replace(/^\/+/, "");
  return [s3KeyPrefix, cleanNamespace, cleanObjectKey].filter(Boolean).join("/");
}

function normalizePrefix(value: string) {
  return String(value || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function getS3Client() {
  if (!isS3StorageEnabled()) return null;
  if (s3Client !== undefined) return s3Client;

  s3Client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        }
      : undefined,
  });
  return s3Client;
}

function toReadable(value: unknown): Readable | null {
  if (!value) return null;
  if (value instanceof Readable) return value;
  const candidate = value as {
    pipe?: unknown;
    transformToWebStream?: () => unknown;
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  };
  if (typeof candidate.pipe === "function") return candidate as unknown as Readable;
  if (typeof candidate.transformToWebStream === "function") {
    return Readable.fromWeb(candidate.transformToWebStream() as any);
  }
  if (typeof candidate[Symbol.asyncIterator] === "function") {
    return Readable.from(candidate as AsyncIterable<Uint8Array>);
  }
  return null;
}

function isS3NotFound(error: unknown) {
  const err = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404;
}
