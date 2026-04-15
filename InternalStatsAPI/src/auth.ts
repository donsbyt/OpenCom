import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import { env } from "./env.js";
import { findActiveTokenByHash, touchTokenUsage } from "./tokenStore.js";

export type AuthPrincipal =
  | {
      kind: "internal-secret";
      scopes: ["*"];
      tokenId: null;
      tokenName: "internal-sync-secret";
    }
  | {
      kind: "api-token";
      scopes: string[];
      tokenId: number;
      tokenName: string;
    };

export type AuthPolicy = {
  mode?: "all" | "any";
  scopes?: string[];
};

export type AuthContext = {
  credentialSource: "auth-disabled" | "x-internal-stats-secret" | "authorization-bearer" | "x-api-token";
  credentialType: "system" | "shared-secret" | "bearer-token" | "header-token";
  resolvedAt: string;
};

declare module "fastify" {
  interface FastifyRequest {
    authContext?: AuthContext;
    authPrincipal?: AuthPrincipal;
  }
}

type CachedPrincipal = {
  expiresAtMs: number;
  principal: AuthPrincipal | null;
};

type AuthCredentialResolver = {
  id: Exclude<AuthContext["credentialSource"], "auth-disabled">;
  credentialType: Exclude<AuthContext["credentialType"], "system">;
  extract(request: FastifyRequest): string;
  resolve(rawCredential: string): Promise<AuthPrincipal | null>;
};

const AUTH_CACHE_TTL_MS = 30_000;
const TOKEN_USAGE_TOUCH_INTERVAL_MS = 60_000;

const tokenPrincipalCache = new Map<string, CachedPrincipal>();
const tokenLastUsedWriteById = new Map<number, number>();

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function hashToken(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function hasScope(scopes: string[], requiredScope: string) {
  if (scopes.includes("*")) return true;
  if (scopes.includes(requiredScope)) return true;

  const [requiredPrefix] = requiredScope.split(":");
  if (requiredPrefix && scopes.includes(`${requiredPrefix}:*`)) return true;

  return false;
}

function getHeaderValue(request: FastifyRequest, headerName: string) {
  const rawValue = request.headers[headerName.toLowerCase()];
  if (typeof rawValue === "string" && rawValue.trim()) return rawValue.trim();
  return "";
}

function getBearerToken(request: FastifyRequest) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string") return "";

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) return "";

  return match[1].trim();
}

function buildInternalPrincipal(): AuthPrincipal {
  return {
    kind: "internal-secret",
    scopes: ["*"],
    tokenId: null,
    tokenName: "internal-sync-secret",
  };
}

function setRequestAuth(
  request: FastifyRequest,
  principal: AuthPrincipal,
  context: AuthContext,
) {
  request.authPrincipal = principal;
  request.authContext = context;
}

function clearRequestAuth(request: FastifyRequest) {
  request.authPrincipal = undefined;
  request.authContext = undefined;
}

async function resolvePrincipalFromToken(rawToken: string) {
  if (!rawToken) return null;

  const tokenHash = hashToken(rawToken);
  const now = Date.now();
  const cached = tokenPrincipalCache.get(tokenHash);
  if (cached && cached.expiresAtMs > now) {
    return cached.principal;
  }

  const row = await findActiveTokenByHash(tokenHash);
  const principal: AuthPrincipal | null = row
    ? {
        kind: "api-token",
        scopes: row.scopes,
        tokenId: row.id,
        tokenName: row.name,
      }
    : null;

  tokenPrincipalCache.set(tokenHash, {
    expiresAtMs: now + AUTH_CACHE_TTL_MS,
    principal,
  });

  return principal;
}

async function maybeTouchTokenUsage(principal: AuthPrincipal, request: FastifyRequest) {
  if (principal.kind !== "api-token") return;

  const now = Date.now();
  const lastTouched = tokenLastUsedWriteById.get(principal.tokenId) || 0;
  if (now - lastTouched < TOKEN_USAGE_TOUCH_INTERVAL_MS) return;

  tokenLastUsedWriteById.set(principal.tokenId, now);
  await touchTokenUsage(principal.tokenId, request.ip || null);
}

const authCredentialResolvers: AuthCredentialResolver[] = [
  {
    id: "x-internal-stats-secret",
    credentialType: "shared-secret",
    extract(request) {
      return getHeaderValue(request, env.INTERNAL_STATS_SYNC_SECRET_HEADER);
    },
    async resolve(rawCredential) {
      if (!rawCredential) return null;
      if (!safeEqual(rawCredential, env.INTERNAL_STATS_SYNC_SECRET)) return null;
      return buildInternalPrincipal();
    },
  },
  {
    id: "authorization-bearer",
    credentialType: "bearer-token",
    extract(request) {
      return getBearerToken(request);
    },
    async resolve(rawCredential) {
      return resolvePrincipalFromToken(rawCredential);
    },
  },
  {
    id: "x-api-token",
    credentialType: "header-token",
    extract(request) {
      return getHeaderValue(request, env.INTERNAL_STATS_API_TOKEN_HEADER);
    },
    async resolve(rawCredential) {
      return resolvePrincipalFromToken(rawCredential);
    },
  },
];

function isPolicySatisfied(principal: AuthPrincipal, policy: AuthPolicy) {
  const requiredScopes = policy.scopes || [];
  if (requiredScopes.length === 0) return true;

  const mode = policy.mode || "all";
  if (mode === "any") {
    return requiredScopes.some((scope) => hasScope(principal.scopes, scope));
  }

  return requiredScopes.every((scope) => hasScope(principal.scopes, scope));
}

async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<AuthPrincipal | null> {
  if (request.authPrincipal) return request.authPrincipal;

  if (!env.INTERNAL_STATS_REQUIRE_AUTH) {
    const principal = buildInternalPrincipal();
    setRequestAuth(request, principal, {
      credentialSource: "auth-disabled",
      credentialType: "system",
      resolvedAt: new Date().toISOString(),
    });
    return principal;
  }

  for (const resolver of authCredentialResolvers) {
    const rawCredential = resolver.extract(request);
    if (!rawCredential) continue;

    const principal = await resolver.resolve(rawCredential);
    if (!principal) continue;

    await maybeTouchTokenUsage(principal, request);
    setRequestAuth(request, principal, {
      credentialSource: resolver.id,
      credentialType: resolver.credentialType,
      resolvedAt: new Date().toISOString(),
    });
    return principal;
  }

  clearRequestAuth(request);
  await reply.code(401).send({
    error: "UNAUTHORIZED",
    acceptedCredentialSources: authCredentialResolvers.map((resolver) => resolver.id),
  });
  return null;
}

export function requireAuth(policy: AuthPolicy = {}): preHandlerHookHandler {
  return async (request, reply) => {
    const principal = await authenticateRequest(request, reply);
    if (!principal) return;

    if (isPolicySatisfied(principal, policy)) return;

    return reply.code(403).send({
      error: "FORBIDDEN",
      requiredScopes: policy.scopes || [],
      matchMode: policy.mode || "all",
    });
  };
}

export function requireScope(scope: string) {
  return requireAuth({ scopes: [scope] });
}

export function requireGenSecret() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const configured = String(env.INTERNAL_STATS_GEN_SECRET || "").trim();
    if (!configured) {
      return reply.code(503).send({
        error: "GEN_SECRET_DISABLED",
      });
    }

    const provided = getHeaderValue(request, env.INTERNAL_STATS_GEN_SECRET_HEADER);
    if (!provided || !safeEqual(provided, configured)) {
      return reply.code(401).send({
        error: "UNAUTHORIZED",
        expectedHeader: env.INTERNAL_STATS_GEN_SECRET_HEADER,
      });
    }
  };
}

export function generateRawApiToken() {
  return `istat_${randomBytes(32).toString("hex")}`;
}

export function hashRawApiToken(rawToken: string) {
  return hashToken(rawToken);
}
