import fs from "node:fs";
import { Readable } from "node:stream";
import { Storage } from "@google-cloud/storage";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "./env.js";

const remoteStorageEnabled = env.STORAGE_PROVIDER === "s3" || env.STORAGE_PROVIDER === "gcs";
const bucketName = env.NODE_STORAGE_BUCKET || env.NODE_S3_BUCKET || null;
const objectKeyPrefix = normalizePrefix(env.S3_KEY_PREFIX || "");

const s3Client = env.STORAGE_PROVIDER === "s3"
  ? new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
        ? {
            accessKeyId: env.S3_ACCESS_KEY_ID,
            secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          }
        : undefined,
    })
  : null;

const gcsClient = env.STORAGE_PROVIDER === "gcs"
  ? new Storage({
      projectId: env.GCS_PROJECT_ID,
    })
  : null;

export function isS3StorageEnabled() {
  return remoteStorageEnabled;
}

export async function uploadFileToObjectStorage(
  namespace: string,
  objectKey: string,
  absoluteFilePath: string,
  contentType?: string,
) {
  const key = resolveObjectKey(namespace, objectKey);
  if (env.STORAGE_PROVIDER === "gcs") {
    if (!gcsClient || !bucketName) return;
    await gcsClient.bucket(bucketName).upload(absoluteFilePath, {
      destination: key,
      metadata: contentType ? { contentType } : undefined,
    });
    return;
  }

  if (!s3Client || !bucketName) return;
  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: fs.createReadStream(absoluteFilePath),
      ContentType: contentType,
    }),
  );
}

export async function getObjectStreamFromStorage(
  namespace: string,
  objectKey: string,
): Promise<Readable | null> {
  const key = resolveObjectKey(namespace, objectKey);
  if (env.STORAGE_PROVIDER === "gcs") {
    if (!gcsClient || !bucketName) return null;
    const file = gcsClient.bucket(bucketName).file(key);
    const [exists] = await file.exists();
    if (!exists) return null;
    return file.createReadStream();
  }

  if (!s3Client || !bucketName) return null;
  try {
    const result = await s3Client.send(
      new GetObjectCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );
    return toReadable(result.Body);
  } catch (error) {
    if (isS3NotFound(error)) return null;
    throw error;
  }
}

export async function deleteObjectFromStorage(namespace: string, objectKey: string) {
  const key = resolveObjectKey(namespace, objectKey);
  if (env.STORAGE_PROVIDER === "gcs") {
    if (!gcsClient || !bucketName) return;
    try {
      await gcsClient.bucket(bucketName).file(key).delete();
    } catch (error) {
      if (!isGcsNotFound(error)) throw error;
    }
    return;
  }

  if (!s3Client || !bucketName) return;
  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucketName,
        Key: key,
      }),
    );
  } catch (error) {
    if (!isS3NotFound(error)) throw error;
  }
}

function resolveObjectKey(namespace: string, objectKey: string) {
  const cleanNamespace = normalizePrefix(namespace);
  const cleanObjectKey = String(objectKey || "").replace(/^\/+/, "");
  return [objectKeyPrefix, cleanNamespace, cleanObjectKey].filter(Boolean).join("/");
}

function normalizePrefix(value: string) {
  return String(value || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
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

function isGcsNotFound(error: unknown) {
  const err = error as { code?: number } | null;
  return err?.code === 404;
}
