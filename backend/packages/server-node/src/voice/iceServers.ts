import crypto from "crypto";
import { env } from "../env.js";

function parseIceUrls(rawValue: string | undefined): string[] {
  return String(rawValue || "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeIceServerUrls(urls: string[]) {
  return urls.length === 1 ? urls[0] : urls;
}

function sanitizeTurnUsernameFragment(value: string): string {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_.:@=-]/g, "_")
    .slice(0, 64);
}

export function buildVoiceIceServers(userId: string) {
  const stunUrls = parseIceUrls(env.VOICE_STUN_URLS);
  const turnUrls = parseIceUrls(env.VOICE_TURN_URLS);
  const iceServers: Array<{
    urls: string | string[];
    username?: string;
    credential?: string;
  }> = [];

  if (stunUrls.length > 0) {
    iceServers.push({ urls: normalizeIceServerUrls(stunUrls) });
  }

  if (turnUrls.length > 0 && env.VOICE_TURN_SECRET) {
    const expiry = Math.floor(Date.now() / 1000) + env.VOICE_TURN_TTL_SECONDS;
    const username = `${expiry}:${sanitizeTurnUsernameFragment(userId) || "user"}`;
    const credential = crypto
      .createHmac("sha1", env.VOICE_TURN_SECRET)
      .update(username)
      .digest("base64");

    iceServers.push({
      urls: normalizeIceServerUrls(turnUrls),
      username,
      credential,
    });
  }

  return iceServers;
}
