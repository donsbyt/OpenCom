import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import type { FastifyInstance } from "fastify";
import {
  GatewayEnvelope,
  MediaIdentify,
} from "@ods/shared/events.js";
import {
  verifyMediaAccessToken,
  type MediaTokenClaims,
} from "@ods/shared/mediaToken.js";
import { q } from "./db.js";
import { env, isMediaOriginAllowed } from "./env.js";
import {
  getRouterRtpCapabilities,
  replacePeerSession,
  createWebRtcTransport,
  connectTransport,
  restartIce,
  produce,
  consume,
  listProducers,
  closeProducer,
  closePeer,
  getMediasoupDiagnostics,
} from "./voice/mediasoup.js";
import { createLogger, sanitizeErrorMessage } from "./logger.js";
import { resolveCoreUserProfiles } from "./userDirectory.js";

const logger = createLogger("gateway:media");
const INTERNAL_SECRET_HEADER = "x-node-sync-secret";

type Conn = {
  ws: any;
  connId: string;
  userId: string;
  serverId: string;
  coreServerId: string;
  seq: number;
  roles: string[];
  guilds: Set<string>;
  channels: Set<string>;
  tokenScope: {
    guildId: string;
    channelId: string;
    roomId: string;
    privateCallId?: string;
  };
  voice?: { guildId: string; channelId: string };
};

type InternalVoiceBody = {
  guildId?: string;
  channelId?: string;
  userId?: string;
  muted?: boolean;
  deafened?: boolean;
};

function errorPayload(code: string, error: unknown) {
  const details = sanitizeErrorMessage(error);
  return {
    error: code,
    code,
    details,
    ...(env.NODE_ENV !== "production" && error instanceof Error && error.stack
      ? { stack: error.stack }
      : {}),
  };
}

function validateInternalSecret(req: any, rep: any) {
  if (!env.MEDIA_SYNC_SECRET) {
    rep.code(503).send({ error: "MEDIA_SYNC_SECRET_NOT_CONFIGURED" });
    return false;
  }
  if (req.headers[INTERNAL_SECRET_HEADER] !== env.MEDIA_SYNC_SECRET) {
    rep.code(401).send({ error: "INVALID_SYNC_SECRET" });
    return false;
  }
  return true;
}

function hasRoomScope(conn: Conn, guildId: string, channelId: string) {
  return conn.tokenScope.guildId === guildId
    && conn.tokenScope.channelId === channelId;
}

export function attachMediaGateway(app: FastifyInstance) {
  const wss = new WebSocketServer({ noServer: true });
  const conns = new Set<Conn>();
  const activeVoiceSessionByGuildUser = new Map<string, string>();

  app.get("/health", async () => ({
    ok: true,
    wsPath: "/gateway",
    media: getMediasoupDiagnostics(),
  }));

  app.get("/debug/voice", async (_req, rep) => {
    if (!env.DEBUG_VOICE) return rep.code(404).send({ error: "NOT_FOUND" });
    return {
      connections: conns.size,
      activeVoiceConnections: [...conns].filter((c) => !!c.voice).length,
      diagnostics: getMediasoupDiagnostics(),
    };
  });

  app.post("/v1/internal/voice/member-state", async (req: any, rep) => {
    if (!validateInternalSecret(req, rep)) return;
    const body = (req.body || {}) as InternalVoiceBody;
    const guildId = String(body.guildId || "").trim();
    const userId = String(body.userId || "").trim();
    if (!guildId || !userId) {
      return rep.code(400).send({ error: "INVALID_BODY" });
    }
    await emitVoiceState(guildId, userId);
    return rep.send({ ok: true });
  });

  app.post("/v1/internal/voice/disconnect-member", async (req: any, rep) => {
    if (!validateInternalSecret(req, rep)) return;
    const body = (req.body || {}) as InternalVoiceBody;
    const guildId = String(body.guildId || "").trim();
    const channelId = String(body.channelId || "").trim();
    const userId = String(body.userId || "").trim();
    if (!guildId || !channelId || !userId) {
      return rep.code(400).send({ error: "INVALID_BODY" });
    }

    for (const conn of conns) {
      if (conn.userId !== userId || !conn.voice) continue;
      if (conn.voice.guildId !== guildId || conn.voice.channelId !== channelId) {
        continue;
      }
      cleanupVoicePeerAndNotify(conn);
      await leaveVoice(conn);
      sendDispatch(conn, "VOICE_LEFT", {
        ok: true,
        guildId,
        channelId,
        reason: "SERVER_DISCONNECT",
      });
    }

    await emitVoiceState(guildId, userId);
    return rep.send({ ok: true });
  });

  app.post("/v1/internal/voice/close-room", async (req: any, rep) => {
    if (!validateInternalSecret(req, rep)) return;
    const body = (req.body || {}) as InternalVoiceBody;
    const guildId = String(body.guildId || "").trim();
    const channelId = String(body.channelId || "").trim();
    if (!guildId || !channelId) {
      return rep.code(400).send({ error: "INVALID_BODY" });
    }

    const targets = [...conns].filter(
      (conn) =>
        conn.voice?.guildId === guildId && conn.voice?.channelId === channelId,
    );

    for (const conn of targets) {
      cleanupVoicePeerAndNotify(conn);
      await leaveVoice(conn);
      sendDispatch(conn, "VOICE_LEFT", {
        ok: true,
        guildId,
        channelId,
        reason: "ROOM_CLOSED",
      });
    }

    return rep.send({ ok: true, disconnected: targets.length });
  });

  function send(ws: any, msg: GatewayEnvelope) {
    ws.send(JSON.stringify(msg));
  }

  function sendDispatch(conn: Conn, t: string, d: any) {
    conn.seq += 1;
    send(conn.ws, { op: "DISPATCH", t, s: conn.seq, d });
  }

  function sendVoiceError(
    conn: Conn,
    code: string,
    error: unknown,
    extra: Record<string, unknown> = {},
  ) {
    const payload = {
      ...errorPayload(code, error),
      ...(conn.voice
        ? { guildId: conn.voice.guildId, channelId: conn.voice.channelId }
        : {}),
      ...extra,
    };
    logger.error("VOICE_ERROR dispatched", error, {
      connId: conn.connId,
      userId: conn.userId,
      guildId: conn.voice?.guildId,
      channelId: conn.voice?.channelId,
      code,
      ...extra,
    });
    sendDispatch(conn, "VOICE_ERROR", payload);
  }

  function shouldReceiveGuildVoiceEvents(conn: Conn, guildId: string) {
    return conn.guilds.has(guildId) || conn.voice?.guildId === guildId;
  }

  function broadcastGuild(guildId: string, t: string, d: any) {
    for (const conn of conns) {
      if (!shouldReceiveGuildVoiceEvents(conn, guildId)) continue;
      sendDispatch(conn, t, d);
    }
  }

  function broadcastVoiceChannel(
    guildId: string,
    channelId: string,
    t: string,
    d: any,
    excludeUserId?: string,
  ) {
    for (const conn of conns) {
      if (!conn.voice) continue;
      if (conn.voice.guildId !== guildId || conn.voice.channelId !== channelId) {
        continue;
      }
      if (excludeUserId && conn.userId === excludeUserId) continue;
      sendDispatch(conn, t, d);
    }
  }

  function voiceSessionKey(guildId: string, userId: string) {
    return `${guildId}:${userId}`;
  }

  function isVoiceSessionOwner(conn: Conn, voice = conn.voice) {
    if (!voice) return false;
    const owner = activeVoiceSessionByGuildUser.get(
      voiceSessionKey(voice.guildId, conn.userId),
    );
    return !owner || owner === conn.connId;
  }

  async function emitVoiceState(guildId: string, userId: string) {
    const profiles = await resolveCoreUserProfiles([userId]);
    const profile = profiles.get(userId);
    const rows = await q<any>(
      `SELECT guild_id, channel_id, user_id, muted, deafened, updated_at
       FROM voice_states
       WHERE guild_id=:guildId AND user_id=:userId`,
      { guildId, userId },
    );

    if (!rows.length) {
      broadcastGuild(guildId, "VOICE_STATE_UPDATE", {
        guildId,
        userId,
        channelId: null,
        muted: false,
        deafened: false,
        username: profile?.username || userId,
        pfp_url: profile?.pfpUrl ?? null,
      });
      return;
    }

    const row = rows[0];
    broadcastGuild(guildId, "VOICE_STATE_UPDATE", {
      guildId: row.guild_id,
      channelId: row.channel_id,
      userId: row.user_id,
      muted: !!row.muted,
      deafened: !!row.deafened,
      updatedAt: new Date(row.updated_at).toISOString(),
      username: profile?.username || row.user_id,
      pfp_url: profile?.pfpUrl ?? null,
    });
  }

  async function emitRoomSnapshotToConn(conn: Conn, guildId: string, channelId: string) {
    const rows = await q<{
      guild_id: string;
      channel_id: string;
      user_id: string;
      muted: number;
      deafened: number;
      updated_at: string;
    }>(
      `SELECT guild_id, channel_id, user_id, muted, deafened, updated_at
       FROM voice_states
       WHERE guild_id=:guildId AND channel_id=:channelId
       ORDER BY updated_at ASC`,
      { guildId, channelId },
    );
    if (!rows.length) return;

    const profiles = await resolveCoreUserProfiles(rows.map((row) => row.user_id));
    for (const row of rows) {
      const profile = profiles.get(row.user_id);
      sendDispatch(conn, "VOICE_STATE_UPDATE", {
        guildId: row.guild_id,
        channelId: row.channel_id,
        userId: row.user_id,
        muted: !!row.muted,
        deafened: !!row.deafened,
        updatedAt: new Date(row.updated_at).toISOString(),
        username: profile?.username || row.user_id,
        pfp_url: profile?.pfpUrl ?? null,
      });
    }
  }

  async function leaveVoice(conn: Conn) {
    if (!conn.voice) return;
    const { guildId } = conn.voice;
    const isOwner = isVoiceSessionOwner(conn);
    conn.voice = undefined;
    if (!isOwner) return;

    activeVoiceSessionByGuildUser.delete(voiceSessionKey(guildId, conn.userId));

    await q(`DELETE FROM voice_states WHERE guild_id=:guildId AND user_id=:userId`, {
      guildId,
      userId: conn.userId,
    });

    await emitVoiceState(guildId, conn.userId);
  }

  function notifyVoiceProducersClosed(
    guildId: string,
    channelId: string,
    userId: string,
    closedProducerIds: string[],
  ) {
    for (const producerId of closedProducerIds) {
      broadcastVoiceChannel(
        guildId,
        channelId,
        "VOICE_PRODUCER_CLOSED",
        { guildId, channelId, producerId, userId },
        userId,
      );
    }
  }

  function notifyVoicePeerClosed(
    guildId: string,
    channelId: string,
    userId: string,
    closedProducerIds: string[],
  ) {
    notifyVoiceProducersClosed(guildId, channelId, userId, closedProducerIds);
    broadcastVoiceChannel(
      guildId,
      channelId,
      "VOICE_USER_LEFT",
      { guildId, channelId, userId },
      userId,
    );
  }

  function cleanupVoicePeerAndNotify(conn: Conn) {
    if (!conn.voice) return;
    if (!isVoiceSessionOwner(conn)) return;
    const { guildId, channelId } = conn.voice;
    const closedProducerIds = closePeer(
      guildId,
      channelId,
      conn.userId,
      conn.connId,
    );
    notifyVoicePeerClosed(guildId, channelId, conn.userId, closedProducerIds);
  }

  function supersedeVoiceConnections(conn: Conn, guildId: string) {
    for (const other of conns) {
      if (other === conn || other.userId !== conn.userId || !other.voice) {
        continue;
      }
      if (other.voice.guildId !== guildId) continue;

      const { guildId: otherGuildId, channelId: otherChannelId } = other.voice;
      const closedProducerIds = closePeer(
        otherGuildId,
        otherChannelId,
        other.userId,
        other.connId,
      );
      notifyVoiceProducersClosed(
        otherGuildId,
        otherChannelId,
        other.userId,
        closedProducerIds,
      );
      other.voice = undefined;
    }
  }

  async function ensureVoiceChannelExists(guildId: string, channelId: string) {
    const rows = await q<{ id: string; type: string }>(
      `SELECT id, type FROM channels WHERE id=:channelId AND guild_id=:guildId`,
      { guildId, channelId },
    );
    if (!rows.length || rows[0].type !== "voice") {
      throw new Error("VOICE_CHANNEL_NOT_FOUND");
    }
  }

  function claimToConnScope(claims: MediaTokenClaims) {
    return {
      guildId: claims.guild_id,
      channelId: claims.channel_id,
      roomId: claims.room_id,
      privateCallId: claims.private_call_id,
    };
  }

  app.server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/gateway")) return;
    if (!isMediaOriginAllowed(req.headers.origin as string | undefined)) {
      logger.warn("Rejected media websocket origin", {
        origin: req.headers.origin || null,
        url: req.url,
      });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    let conn: Conn | null = null;

    logger.info("Media websocket connected", {
      origin: req.headers.origin || null,
      remoteAddress: req.socket.remoteAddress || null,
    });

    send(ws, { op: "HELLO", d: { heartbeat_interval: 25000 } });

    ws.on("message", async (raw: Buffer) => {
      let msg: GatewayEnvelope;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch (error) {
        logger.warn("Invalid media gateway payload", {
          raw: raw.toString("utf8").slice(0, 500),
          details: sanitizeErrorMessage(error),
        });
        return;
      }

      if (msg.op === "IDENTIFY") {
        const identify = msg.d as MediaIdentify;
        try {
          const claims = await verifyMediaAccessToken(String(identify?.mediaToken || ""), {
            secret: env.MEDIA_TOKEN_SECRET,
            issuer: env.MEDIA_TOKEN_ISSUER,
            ...(env.MEDIA_TOKEN_AUDIENCE
              ? { audience: env.MEDIA_TOKEN_AUDIENCE }
              : {}),
          });

          conn = {
            ws,
            connId: randomUUID(),
            userId: claims.sub,
            serverId: claims.server_id,
            coreServerId: claims.core_server_id || claims.server_id,
            seq: 0,
            roles: claims.roles || [],
            guilds: new Set(),
            channels: new Set(),
            tokenScope: claimToConnScope(claims),
          };
          conns.add(conn);

          logger.info("Media gateway identified", {
            connId: conn.connId,
            userId: conn.userId,
            roomId: conn.tokenScope.roomId,
            guildId: conn.tokenScope.guildId,
            channelId: conn.tokenScope.channelId,
            privateCallId: conn.tokenScope.privateCallId || null,
          });

          send(ws, {
            op: "READY",
            d: {
              user: { id: conn.userId, username: "unknown" },
              guildId: conn.tokenScope.guildId,
              channelId: conn.tokenScope.channelId,
              roomId: conn.tokenScope.roomId,
            },
          });
        } catch (error) {
          logger.error("Media gateway identify failed", error);
          send(ws, { op: "ERROR", d: { error: "INVALID_MEDIA_TOKEN" } });
          ws.close();
        }
        return;
      }

      if (!conn) return;

      if (msg.op === "HEARTBEAT") {
        send(ws, { op: "HEARTBEAT_ACK" });
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "SUBSCRIBE_GUILD") {
        const guildId = String((msg.d as any)?.guildId || "").trim();
        if (guildId && guildId === conn.tokenScope.guildId) {
          conn.guilds.add(guildId);
        }
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "SUBSCRIBE_CHANNEL") {
        const channelId = String((msg.d as any)?.channelId || "").trim();
        if (channelId && channelId === conn.tokenScope.channelId) {
          conn.channels.add(channelId);
        }
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "VOICE_JOIN") {
        const guildId = String((msg.d as any)?.guildId || "").trim();
        const channelId = String((msg.d as any)?.channelId || "").trim();
        const requestId =
          typeof (msg.d as any)?.requestId === "string"
            ? (msg.d as any).requestId
            : undefined;

        if (!guildId || !channelId) {
          sendVoiceError(conn, "BAD_VOICE_JOIN", new Error("Missing guildId/channelId"), { requestId });
          return;
        }

        if (!hasRoomScope(conn, guildId, channelId)) {
          sendVoiceError(conn, "VOICE_SCOPE_MISMATCH", new Error("Token scope does not match requested room"), { requestId });
          return;
        }

        try {
          logger.info("VOICE_JOIN", {
            connId: conn.connId,
            userId: conn.userId,
            guildId,
            channelId,
            roomId: conn.tokenScope.roomId,
          });

          await ensureVoiceChannelExists(guildId, channelId);

          if (conn.voice) {
            const isSameChannel =
              conn.voice.guildId === guildId && conn.voice.channelId === channelId;
            cleanupVoicePeerAndNotify(conn);
            if (!isSameChannel) {
              await leaveVoice(conn);
            }
          }

          supersedeVoiceConnections(conn, guildId);

          const replacedProducerIds = await replacePeerSession(
            guildId,
            channelId,
            conn.userId,
            conn.connId,
          );
          notifyVoiceProducersClosed(
            guildId,
            channelId,
            conn.userId,
            replacedProducerIds,
          );

          await q(
            `INSERT INTO voice_states (guild_id,channel_id,user_id,muted,deafened,updated_at)
             VALUES (:guildId,:channelId,:userId,0,0,NOW())
             ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id),updated_at=NOW()`,
            { guildId, channelId, userId: conn.userId },
          );

          conn.guilds.add(guildId);
          conn.channels.add(channelId);
          activeVoiceSessionByGuildUser.set(
            voiceSessionKey(guildId, conn.userId),
            conn.connId,
          );
          conn.voice = { guildId, channelId };

          const rtpCapabilities = await getRouterRtpCapabilities(guildId, channelId);
          const producers = listProducers(guildId, channelId).filter(
            (producer) => producer.userId !== conn?.userId,
          );

          sendDispatch(conn, "VOICE_JOINED", {
            guildId,
            channelId,
            rtpCapabilities,
            producers,
            requestId,
          });
          await emitRoomSnapshotToConn(conn, guildId, channelId);
          await emitVoiceState(guildId, conn.userId);
        } catch (error) {
          sendVoiceError(conn, "VOICE_JOIN_FAILED", error, {
            guildId,
            channelId,
            requestId,
          });
        }
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "VOICE_LEAVE") {
        try {
          logger.info("VOICE_LEAVE", {
            connId: conn.connId,
            userId: conn.userId,
            guildId: conn.voice?.guildId,
            channelId: conn.voice?.channelId,
          });
          cleanupVoicePeerAndNotify(conn);
          await leaveVoice(conn);
          sendDispatch(conn, "VOICE_LEFT", { ok: true });
        } catch (error) {
          sendVoiceError(conn, "VOICE_LEAVE_FAILED", error);
        }
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "VOICE_SPEAKING") {
        try {
          if (!conn.voice) {
            sendVoiceError(conn, "NOT_IN_VOICE_CHANNEL", new Error("No active voice session"));
            return;
          }

          const speaking = !!(msg.d as any)?.speaking;
          const guildId = conn.voice.guildId;
          const channelId = conn.voice.channelId;

          broadcastGuild(guildId, "VOICE_SPEAKING", {
            guildId,
            channelId,
            userId: conn.userId,
            speaking,
          });
        } catch (error) {
          sendVoiceError(conn, "VOICE_SPEAKING_FAILED", error);
        }
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "VOICE_CREATE_TRANSPORT") {
        try {
          const guildId = (msg.d as any)?.guildId ?? conn.voice?.guildId;
          const channelId = (msg.d as any)?.channelId ?? conn.voice?.channelId;
          const direction = (msg.d as any)?.direction;
          const requestId =
            typeof (msg.d as any)?.requestId === "string"
              ? (msg.d as any).requestId
              : undefined;

          if (typeof guildId !== "string" || typeof channelId !== "string") {
            sendVoiceError(conn, "BAD_VOICE_CONTEXT", new Error("Missing guildId/channelId"), { requestId });
            return;
          }

          if (direction !== "send" && direction !== "recv") {
            sendVoiceError(conn, "BAD_TRANSPORT_DIRECTION", new Error("direction must be send or recv"), { requestId });
            return;
          }

          if (!conn.voice || conn.voice.guildId !== guildId || conn.voice.channelId !== channelId) {
            sendVoiceError(conn, "NOT_IN_VOICE_CHANNEL", new Error("Transport creation requested outside joined voice"), { requestId });
            return;
          }

          const transport = await createWebRtcTransport(
            guildId,
            channelId,
            conn.userId,
            conn.connId,
            direction,
          );
          sendDispatch(conn, "VOICE_TRANSPORT_CREATED", {
            guildId,
            channelId,
            direction,
            transport,
            requestId,
          });
        } catch (error) {
          sendVoiceError(conn, "VOICE_TRANSPORT_CREATE_FAILED", error);
        }
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "VOICE_CONNECT_TRANSPORT") {
        try {
          const requestId =
            typeof (msg.d as any)?.requestId === "string"
              ? (msg.d as any).requestId
              : undefined;
          if (!conn.voice) {
            sendVoiceError(conn, "NOT_IN_VOICE_CHANNEL", new Error("No active voice session"), { requestId });
            return;
          }

          const transportId = (msg.d as any)?.transportId;
          const dtlsParameters = (msg.d as any)?.dtlsParameters;
          if (typeof transportId !== "string" || !dtlsParameters) {
            sendVoiceError(conn, "BAD_TRANSPORT_CONNECT", new Error("Missing transportId/dtlsParameters"), { requestId });
            return;
          }

          const { guildId, channelId } = conn.voice;
          await connectTransport(
            guildId,
            channelId,
            conn.userId,
            transportId,
            dtlsParameters,
            conn.connId,
          );
          sendDispatch(conn, "VOICE_TRANSPORT_CONNECTED", {
            transportId,
            guildId,
            channelId,
            requestId,
          });
        } catch (error) {
          sendVoiceError(conn, "VOICE_TRANSPORT_CONNECT_FAILED", error);
        }
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "VOICE_RESTART_ICE") {
        try {
          const requestId =
            typeof (msg.d as any)?.requestId === "string"
              ? (msg.d as any).requestId
              : undefined;
          if (!conn.voice) {
            sendVoiceError(conn, "NOT_IN_VOICE_CHANNEL", new Error("No active voice session"), { requestId });
            return;
          }

          const transportId = (msg.d as any)?.transportId;
          if (typeof transportId !== "string" || !transportId) {
            sendVoiceError(conn, "BAD_RESTART_ICE", new Error("Missing transportId"), { requestId });
            return;
          }

          const { guildId, channelId } = conn.voice;
          const result = await restartIce(
            guildId,
            channelId,
            conn.userId,
            transportId,
            conn.connId,
          );
          sendDispatch(conn, "VOICE_ICE_RESTARTED", {
            guildId,
            channelId,
            transportId: result.transportId,
            iceParameters: result.iceParameters,
            requestId,
          });
        } catch (error) {
          sendVoiceError(conn, "VOICE_RESTART_ICE_FAILED", error);
        }
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "VOICE_PRODUCE") {
        try {
          const requestId =
            typeof (msg.d as any)?.requestId === "string"
              ? (msg.d as any).requestId
              : undefined;
          if (!conn.voice) {
            sendVoiceError(conn, "NOT_IN_VOICE_CHANNEL", new Error("No active voice session"), { requestId });
            return;
          }

          const transportId = (msg.d as any)?.transportId;
          const kind = (msg.d as any)?.kind;
          const rtpParameters = (msg.d as any)?.rtpParameters;
          const source = (msg.d as any)?.source;

          if (typeof transportId !== "string" || (kind !== "audio" && kind !== "video") || !rtpParameters) {
            sendVoiceError(conn, "BAD_VOICE_PRODUCE", new Error("Missing transportId/kind/rtpParameters"), { requestId });
            return;
          }

          if (source !== undefined && typeof source !== "string") {
            sendVoiceError(conn, "BAD_VOICE_PRODUCE", new Error("source must be a string"), { requestId });
            return;
          }

          const guildId = conn.voice.guildId;
          const channelId = conn.voice.channelId;
          const result = await produce(
            guildId,
            channelId,
            conn.userId,
            transportId,
            kind,
            rtpParameters,
            source,
            conn.connId,
          );
          sendDispatch(conn, "VOICE_PRODUCED", {
            ...result,
            userId: conn.userId,
            guildId,
            channelId,
            requestId,
          });
          broadcastVoiceChannel(
            guildId,
            channelId,
            "VOICE_NEW_PRODUCER",
            {
              guildId,
              channelId,
              userId: conn.userId,
              producerId: result.producerId,
              source: result.source,
            },
            conn.userId,
          );
        } catch (error) {
          sendVoiceError(conn, "VOICE_PRODUCE_FAILED", error);
        }
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "VOICE_CONSUME") {
        try {
          const requestId =
            typeof (msg.d as any)?.requestId === "string"
              ? (msg.d as any).requestId
              : undefined;
          if (!conn.voice) {
            sendVoiceError(conn, "NOT_IN_VOICE_CHANNEL", new Error("No active voice session"), { requestId });
            return;
          }

          const transportId = (msg.d as any)?.transportId;
          const producerId = (msg.d as any)?.producerId;
          const rtpCapabilities = (msg.d as any)?.rtpCapabilities;

          if (typeof transportId !== "string" || typeof producerId !== "string" || !rtpCapabilities) {
            sendVoiceError(conn, "BAD_VOICE_CONSUME", new Error("Missing transportId/producerId/rtpCapabilities"), { requestId });
            return;
          }

          const data = await consume(
            conn.voice.guildId,
            conn.voice.channelId,
            conn.userId,
            transportId,
            producerId,
            rtpCapabilities,
            conn.connId,
          );

          sendDispatch(conn, "VOICE_CONSUMED", {
            ...data,
            guildId: conn.voice.guildId,
            channelId: conn.voice.channelId,
            requestId,
          });
        } catch (error) {
          sendVoiceError(conn, "VOICE_CONSUME_FAILED", error);
        }
        return;
      }

      if (msg.op === "DISPATCH" && msg.t === "VOICE_CLOSE_PRODUCER") {
        try {
          if (!conn.voice) {
            sendVoiceError(conn, "NOT_IN_VOICE_CHANNEL", new Error("No active voice session"));
            return;
          }

          const producerId = (msg.d as any)?.producerId;
          if (typeof producerId !== "string" || !producerId) {
            sendVoiceError(conn, "BAD_VOICE_CLOSE_PRODUCER", new Error("Missing producerId"));
            return;
          }

          const { guildId, channelId } = conn.voice;
          const closed = closeProducer(guildId, channelId, conn.userId, producerId);
          if (!closed) {
            sendVoiceError(conn, "VOICE_PRODUCER_NOT_FOUND", new Error("Producer not found"), { producerId });
            return;
          }

          sendDispatch(conn, "VOICE_PRODUCER_CLOSED", {
            guildId,
            channelId,
            producerId,
            userId: conn.userId,
          });
          broadcastVoiceChannel(
            guildId,
            channelId,
            "VOICE_PRODUCER_CLOSED",
            { guildId, channelId, producerId, userId: conn.userId },
            conn.userId,
          );
        } catch (error) {
          sendVoiceError(conn, "VOICE_CLOSE_PRODUCER_FAILED", error);
        }
        return;
      }
    });

    ws.on("close", async () => {
      if (conn) {
        logger.info("Media websocket disconnected", {
          connId: conn.connId,
          userId: conn.userId,
          guildId: conn.voice?.guildId,
          channelId: conn.voice?.channelId,
        });
        cleanupVoicePeerAndNotify(conn);
        await leaveVoice(conn);
        conns.delete(conn);
      }
    });
  });
}
