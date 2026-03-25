import { SignJWT, jwtVerify } from "jose";

const textEncoder = new TextEncoder();

export type MediaTokenClaims = {
  sub: string;
  server_id: string;
  core_server_id: string;
  guild_id: string;
  channel_id: string;
  room_id: string;
  roles: string[];
  permissions: string[];
  platform_role?: string;
  private_call_id?: string;
  scope?: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string | string[];
};

export type SignMediaAccessTokenInput = {
  secret: string;
  userId: string;
  serverId: string;
  guildId: string;
  channelId: string;
  coreServerId?: string;
  roles?: string[];
  permissions?: string[];
  platformRole?: string | null;
  privateCallId?: string | null;
  scope?: string;
  issuer?: string;
  audience?: string;
  expiresInSeconds?: number;
  extraClaims?: Record<string, unknown>;
};

export type VerifyMediaAccessTokenInput = {
  secret: string;
  issuer?: string;
  audience?: string;
};

function normalizedStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(
      values
        .map((value) => String(value || "").trim())
        .filter(Boolean),
    ),
  );
}

export function buildMediaRoomId(guildId: string, channelId: string) {
  return `${String(guildId || "").trim()}:${String(channelId || "").trim()}`;
}

export async function signMediaAccessToken(
  input: SignMediaAccessTokenInput,
): Promise<string> {
  const guildId = String(input.guildId || "").trim();
  const channelId = String(input.channelId || "").trim();
  const userId = String(input.userId || "").trim();
  const serverId = String(input.serverId || "").trim();
  const coreServerId = String(input.coreServerId || serverId).trim();
  const expiresInSeconds = Math.max(
    30,
    Math.floor(Number(input.expiresInSeconds || 300)),
  );

  if (!input.secret || input.secret.length < 16) {
    throw new Error("MEDIA_TOKEN_SECRET_INVALID");
  }
  if (!userId || !serverId || !guildId || !channelId) {
    throw new Error("MEDIA_TOKEN_CLAIMS_INVALID");
  }

  const payload = {
    server_id: serverId,
    core_server_id: coreServerId,
    guild_id: guildId,
    channel_id: channelId,
    room_id: buildMediaRoomId(guildId, channelId),
    roles: normalizedStringArray(input.roles),
    permissions: normalizedStringArray(input.permissions),
    ...(input.platformRole ? { platform_role: String(input.platformRole) } : {}),
    ...(input.privateCallId
      ? { private_call_id: String(input.privateCallId).trim() }
      : {}),
    ...(input.scope ? { scope: String(input.scope).trim() } : {}),
    ...(input.extraClaims || {}),
  };

  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`);

  if (input.issuer) jwt = jwt.setIssuer(input.issuer);
  if (input.audience) jwt = jwt.setAudience(input.audience);

  return jwt.sign(textEncoder.encode(input.secret));
}

export async function verifyMediaAccessToken(
  token: string,
  input: VerifyMediaAccessTokenInput,
): Promise<MediaTokenClaims> {
  if (!input.secret || input.secret.length < 16) {
    throw new Error("MEDIA_TOKEN_SECRET_INVALID");
  }

  const { payload } = await jwtVerify(token, textEncoder.encode(input.secret), {
    ...(input.issuer ? { issuer: input.issuer } : {}),
    ...(input.audience ? { audience: input.audience } : {}),
  });

  const claims = payload as Record<string, unknown>;
  const sub = String(payload.sub || "").trim();
  const serverId = String(claims.server_id || payload.aud || "").trim();
  const coreServerId = String(claims.core_server_id || serverId).trim();
  const guildId = String(claims.guild_id || "").trim();
  const channelId = String(claims.channel_id || "").trim();
  const roomId = String(
    claims.room_id || buildMediaRoomId(guildId, channelId),
  ).trim();

  if (!sub || !serverId || !coreServerId || !guildId || !channelId || !roomId) {
    throw new Error("MEDIA_TOKEN_CLAIMS_INVALID");
  }

  return {
    ...(payload as MediaTokenClaims),
    sub,
    server_id: serverId,
    core_server_id: coreServerId,
    guild_id: guildId,
    channel_id: channelId,
    room_id: roomId,
    roles: normalizedStringArray(claims.roles),
    permissions: normalizedStringArray(claims.permissions),
    platform_role: claims.platform_role
      ? String(claims.platform_role)
      : undefined,
    private_call_id: claims.private_call_id
      ? String(claims.private_call_id)
      : undefined,
    scope: claims.scope ? String(claims.scope) : undefined,
  };
}
