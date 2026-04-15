import { configuredMediaServerUrl, env } from "./env.js";
import { createLogger } from "./logger.js";

const logger = createLogger("media-sync");
const SECRET_HEADER = "x-node-sync-secret";

async function postMediaInternal(path: string, body: Record<string, unknown>) {
  if (!configuredMediaServerUrl || !env.MEDIA_SYNC_SECRET) return false;

  try {
    const response = await fetch(
      `${configuredMediaServerUrl.replace(/\/$/, "")}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [SECRET_HEADER]: env.MEDIA_SYNC_SECRET,
        },
        body: JSON.stringify(body),
      },
    );

    if (!response.ok) {
      logger.warn("Media internal sync request failed", {
        path,
        status: response.status,
      });
      return false;
    }

    return true;
  } catch (error) {
    logger.warn("Media internal sync request errored", {
      path,
      error: error instanceof Error ? error.message : String(error || ""),
    });
    return false;
  }
}

export async function syncMediaVoiceMemberState(input: {
  guildId: string;
  userId: string;
}) {
  return postMediaInternal("/v1/internal/voice/member-state", input);
}

export async function syncMediaDisconnectMember(input: {
  guildId: string;
  channelId: string;
  userId: string;
}) {
  return postMediaInternal("/v1/internal/voice/disconnect-member", input);
}

export async function syncMediaCloseRoom(input: {
  guildId: string;
  channelId: string;
}) {
  return postMediaInternal("/v1/internal/voice/close-room", input);
}
