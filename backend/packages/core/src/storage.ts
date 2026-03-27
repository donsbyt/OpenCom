import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Convert base64 data URL to buffer and file extension
 * Returns { buffer, ext, mimeType } or null if invalid
 */
export function parseBase64Image(dataUrl: string): { buffer: Buffer; ext: string; mimeType: string } | null {
  const match = dataUrl.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;

  const mimeType = `image/${match[1]}`;
  const base64Data = match[2];

  try {
    const buffer = Buffer.from(base64Data, "base64");
    const exts: Record<string, string> = {
      "jpeg": "jpg",
      "png": "png",
      "webp": "webp",
      "gif": "gif",
      "svg+xml": "svg"
    };
    const ext = exts[match[1]] || "bin";
    return { buffer, ext, mimeType };
  } catch {
    return null;
  }
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a"
};

/**
 * Save a raw image buffer to storage. Returns relative path users/{userId}/{filename}.
 */
export function saveProfileImageFromBuffer(
  storageDir: string,
  userId: string,
  imageType: "pfp" | "banner" | "asset",
  buffer: Buffer,
  mimeType: string
): string | null {
  const ext = MIME_TO_EXT[mimeType?.toLowerCase()] ?? "png";

  ensureDir(storageDir);
  const usersDir = path.join(storageDir, "users");
  ensureDir(usersDir);
  const userDir = path.join(usersDir, userId);
  ensureDir(userDir);

  const filename = `${imageType}_${randomId(8)}.${ext}`;
  const filepath = path.join(userDir, filename);

  try {
    fs.writeFileSync(filepath, buffer, { flag: "w" });
    return `users/${userId}/${filename}`;
  } catch {
    return null;
  }
}

/**
 * Save an image to storage and return the relative path for URL construction (base64 path, kept for backward compat)
 */
export function saveProfileImage(
  storageDir: string,
  userId: string,
  imageType: "pfp" | "banner" | "asset",
  base64Data: string
): string | null {
  const parsed = parseBase64Image(base64Data);
  if (!parsed) return null;
  return saveProfileImageFromBuffer(storageDir, userId, imageType, parsed.buffer, parsed.mimeType);
}

/**
 * Delete an old profile image if it exists
 */
export function deleteProfileImage(storageDir: string, relPath: string) {
  if (!relPath?.startsWith("users/")) return;

  const filepath = path.join(storageDir, relPath);
  try {
    fs.unlinkSync(filepath);
  } catch {
    // File doesn't exist or already deleted, that's fine
  }
}
// Extend MIME_TO_EXT with client file types
const CLIENT_MIME_TO_EXT: Record<string, string> = {
  // Windows
  "application/x-msdownload": "exe",
  "application/octet-stream": "bin", // fallback
  // Android
  "application/vnd.android.package-archive": "apk",
  // Linux
  "application/vnd.debian.binary-package": "deb",
  "application/x-debian-package": "deb",
  "application/x-rpm": "rpm",
  "application/x-snap": "snap",
  "application/x-tar": "tar",
  "application/gzip": "tar.gz",
  "application/x-gzip": "tar.gz",
};
 // Infer MIME from filename extension when browser sends application/octet-stream
const CLIENT_EXT_TO_MIME: Record<string, string> = {
  ".exe":    "application/x-msdownload",
  ".apk":    "application/vnd.android.package-archive",
  ".deb":    "application/x-debian-package",
  ".rpm":    "application/x-rpm",
  ".snap":   "application/x-snap",
  ".tar":    "application/x-tar",
  ".gz":     "application/gzip",
};
 
export type ClientPlatform =
  | "windows"
  | "linux_deb"
  | "linux_rpm"
  | "linux_snap"
  | "linux_tar"
  | "android"
  | "ios"
  | "macos";
 
const EXT_TO_PLATFORM: Record<string, ClientPlatform> = {
  ".exe":  "windows",
  ".apk":  "android",
  ".deb":  "linux_deb",
  ".rpm":  "linux_rpm",
  ".snap": "linux_snap",
  ".gz":   "linux_tar",
  ".tar":  "linux_tar",
};
 
export function resolveClientMime(
  rawMime: string | undefined,
  filename: string | undefined,
): string | null {
  const mime = String(rawMime || "").trim().toLowerCase();
  // Trust explicit MIME if we know it
  if (mime && mime !== "application/octet-stream" && CLIENT_MIME_TO_EXT[mime]) {
    return mime;
  }
  // Fall back to extension
  const ext = path.extname(filename || "").toLowerCase();
  return CLIENT_EXT_TO_MIME[ext] ?? null;
}
 
export function resolveClientPlatform(filename: string): ClientPlatform | null {
  const ext = path.extname(filename || "").toLowerCase();
  return EXT_TO_PLATFORM[ext] ?? null;
}
 
export function sha256Hex(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
 
export function saveClientFile(
  storageDir: string,
  platform: ClientPlatform,
  version: string,
  buffer: Buffer,
  mimeType: string,
): string | null {
  const ext = CLIENT_MIME_TO_EXT[mimeType] ?? "bin";
  const clientDir = path.join(storageDir, "clients", platform);
 
  try {
    fs.mkdirSync(clientDir, { recursive: true });
    const filename = `${platform}_${version}_${crypto.randomBytes(6).toString("hex")}.${ext}`;
    const filepath = path.join(clientDir, filename);
    fs.writeFileSync(filepath, buffer, { flag: "w" });
    return `clients/${platform}/${filename}`;
  } catch {
    return null;
  }
}
 