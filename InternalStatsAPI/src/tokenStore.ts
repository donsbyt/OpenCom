import type { RowDataPacket } from "mysql2/promise";
import { exec, q } from "./db.js";

export type ApiTokenRecord = {
  id: number;
  name: string;
  scopes: string[];
  description: string | null;
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  metadata: Record<string, unknown> | null;
};

type ApiTokenRow = RowDataPacket & {
  id: number;
  name: string;
  tokenHash: string;
  scopesJson: unknown;
  description: string | null;
  createdAt: string;
  createdBy: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  metadataJson: unknown;
};

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  if (typeof value === "object") return value as T;
  return null;
}

function normalizeTokenRow(row: ApiTokenRow): ApiTokenRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    scopes: parseJson<string[]>(row.scopesJson) || [],
    description: row.description ? String(row.description) : null,
    createdAt: row.createdAt,
    createdBy: row.createdBy ? String(row.createdBy) : null,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    lastUsedIp: row.lastUsedIp,
    metadata: parseJson<Record<string, unknown>>(row.metadataJson),
  };
}

export async function createApiTokenRecord(input: {
  name: string;
  tokenHash: string;
  scopes: string[];
  description?: string;
  createdBy?: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}) {
  await exec(
    `INSERT INTO internal_stats_api_tokens (
      token_name,
      token_hash,
      scopes_json,
      description,
      created_by,
      expires_at,
      metadata_json
    )
    VALUES (
      :name,
      :tokenHash,
      :scopesJson,
      :description,
      :createdBy,
      :expiresAt,
      :metadataJson
    )`,
    {
      name: input.name,
      tokenHash: input.tokenHash,
      scopesJson: JSON.stringify(input.scopes),
      description: input.description ?? null,
      createdBy: input.createdBy ?? null,
      expiresAt: input.expiresAt ?? null,
      metadataJson: input.metadata ? JSON.stringify(input.metadata) : null,
    },
  );
}

export async function findActiveTokenByHash(hash: string) {
  const rows = await q<ApiTokenRow>(
    `SELECT
      id,
      token_name AS name,
      token_hash AS tokenHash,
      scopes_json AS scopesJson,
      description,
      created_at AS createdAt,
      created_by AS createdBy,
      expires_at AS expiresAt,
      revoked_at AS revokedAt,
      last_used_at AS lastUsedAt,
      last_used_ip AS lastUsedIp,
      metadata_json AS metadataJson
    FROM internal_stats_api_tokens
    WHERE token_hash = :hash
      AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
    LIMIT 1`,
    { hash },
  );

  const row = rows[0];
  if (!row) return null;

  return {
    ...normalizeTokenRow(row),
    tokenHash: row.tokenHash,
  };
}

export async function touchTokenUsage(tokenId: number, ip: string | null) {
  await exec(
    `UPDATE internal_stats_api_tokens
     SET last_used_at = NOW(3),
         last_used_ip = :ip
     WHERE id = :tokenId`,
    {
      tokenId,
      ip: ip ? ip.slice(0, 64) : null,
    },
  );
}

export async function listApiTokens() {
  const rows = await q<ApiTokenRow>(
    `SELECT
      id,
      token_name AS name,
      token_hash AS tokenHash,
      scopes_json AS scopesJson,
      description,
      created_at AS createdAt,
      created_by AS createdBy,
      expires_at AS expiresAt,
      revoked_at AS revokedAt,
      last_used_at AS lastUsedAt,
      last_used_ip AS lastUsedIp,
      metadata_json AS metadataJson
    FROM internal_stats_api_tokens
    ORDER BY created_at DESC, id DESC`,
  );

  return rows.map(normalizeTokenRow);
}

export async function revokeApiToken(tokenId: number) {
  await exec(
    `UPDATE internal_stats_api_tokens
     SET revoked_at = NOW(3)
     WHERE id = :tokenId
       AND revoked_at IS NULL`,
    { tokenId },
  );
}
