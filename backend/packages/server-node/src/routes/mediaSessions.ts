import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  buildMediaRoomId,
  signMediaAccessToken,
} from "@ods/shared/mediaToken.js";
import { q } from "../db.js";
import {
  env,
  resolvedMediaWsUrl,
} from "../env.js";
import { requireGuildMember } from "../auth/requireGuildMember.js";
import { resolveChannelPermissions } from "../permissions/resolve.js";
import { Perm, has } from "../permissions/bits.js";

function getPlatformRole(roles: string[] = []): "user" | "admin" | "owner" {
  if (roles.includes("platform_owner")) return "owner";
  if (roles.includes("platform_admin")) return "admin";
  return "user";
}

export async function mediaSessionRoutes(app: FastifyInstance) {
  app.post(
    "/v1/channels/:channelId/media-session",
    { preHandler: [app.authenticate] } as any,
    async (req: any, rep) => {
      if (!env.MEDIA_TOKEN_SECRET || !resolvedMediaWsUrl) {
        return rep.code(503).send({ error: "MEDIA_SERVICE_UNAVAILABLE" });
      }

      const { channelId } = z
        .object({ channelId: z.string().min(3) })
        .parse(req.params);
      const userId = req.auth.userId as string;
      const roles = Array.isArray(req.auth.roles) ? req.auth.roles : [];
      const serverId = String(req.auth.serverId || "").trim();
      const coreServerId = String(req.auth.coreServerId || serverId).trim();

      const channels = await q<{ guild_id: string; type: string }>(
        `SELECT guild_id, type FROM channels WHERE id=:channelId LIMIT 1`,
        { channelId },
      );
      if (!channels.length) {
        return rep.code(404).send({ error: "CHANNEL_NOT_FOUND" });
      }
      if (channels[0].type !== "voice") {
        return rep.code(400).send({ error: "NOT_VOICE_CHANNEL" });
      }

      const guildId = channels[0].guild_id;

      try {
        await requireGuildMember(guildId, userId, roles, coreServerId);
      } catch {
        return rep.code(403).send({ error: "NOT_GUILD_MEMBER" });
      }

      const perms = await resolveChannelPermissions({
        guildId,
        channelId,
        userId,
        roles,
      });
      if (!has(perms, Perm.VIEW_CHANNEL) || !has(perms, Perm.CONNECT)) {
        return rep.code(403).send({ error: "MISSING_CONNECT_PERMS" });
      }

      const mediaToken = await signMediaAccessToken({
        secret: env.MEDIA_TOKEN_SECRET,
        issuer: env.MEDIA_TOKEN_ISSUER,
        ...(env.MEDIA_TOKEN_AUDIENCE
          ? { audience: env.MEDIA_TOKEN_AUDIENCE }
          : {}),
        expiresInSeconds: env.MEDIA_TOKEN_TTL_SECONDS,
        userId,
        serverId,
        coreServerId,
        guildId,
        channelId,
        roles,
        permissions: [
          "connect",
          ...(has(perms, Perm.SPEAK) ? ["speak"] : []),
        ],
        platformRole: getPlatformRole(roles),
        scope: "voice",
      });

      return rep.send({
        ok: true,
        guildId,
        channelId,
        roomId: buildMediaRoomId(guildId, channelId),
        mediaWsUrl: resolvedMediaWsUrl,
        mediaToken,
      });
    },
  );
}
