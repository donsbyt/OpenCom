import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  generateRawApiToken,
  hashRawApiToken,
  requireAuth,
  requireGenSecret,
} from "../auth.js";
import { env } from "../env.js";
import { getRequestStatsSnapshot } from "../runtimeStats.js";
import {
  getLatestBoostSnapshot,
  getLatestMetric,
  getLatestReport,
  getMetricAggregate,
  getMetricCatalog,
  getMetricHistory,
  getReportById,
  listReports,
  storeReport,
} from "../statsStore.js";
import {
  createApiTokenRecord,
  listApiTokens,
  revokeApiToken,
} from "../tokenStore.js";

const scopeSchema = z
  .string()
  .trim()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9*]+:[a-z0-9*]+$/i, "Invalid scope format");

const metricSchema = z.object({
  key: z.string().trim().min(1).max(128),
  value: z.coerce.number().finite(),
  unit: z.string().trim().min(1).max(32).optional(),
  tags: z.record(z.unknown()).optional(),
  observedAt: z.string().datetime().optional(),
});

const reportSchema = z.object({
  source: z.string().trim().min(2).max(64).optional(),
  kind: z.string().trim().min(2).max(64).default("generic"),
  capturedAt: z.string().datetime().optional(),
  requestId: z.string().trim().max(64).optional(),
  payload: z.record(z.unknown()).optional(),
  metrics: z.array(metricSchema).max(2000).default([]),
});

const coreAdminSnapshotSchema = z
  .object({
    source: z.string().trim().min(2).max(64).optional(),
    generatedAt: z.string().datetime().optional(),
    database: z
      .object({
        boostGrantsActive: z.coerce.number().finite().optional(),
        boostBadgeMembers: z.coerce.number().finite().optional(),
        boostStripeMembers: z.coerce.number().finite().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const latestMetricQuerySchema = z.object({
  key: z.string().trim().min(1).max(128),
  source: z.string().trim().min(2).max(64).optional(),
});

const latestBoostQuerySchema = z.object({
  source: z.string().trim().min(2).max(64).optional(),
});

const latestReportQuerySchema = z.object({
  source: z.string().trim().min(2).max(64).optional(),
  kind: z.string().trim().min(2).max(64).optional(),
});

const reportListQuerySchema = z.object({
  source: z.string().trim().min(2).max(64).optional(),
  kind: z.string().trim().min(2).max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  beforeId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const metricHistoryQuerySchema = z.object({
  key: z.string().trim().min(1).max(128),
  source: z.string().trim().min(2).max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().positive().max(2000).optional(),
});

const metricCatalogQuerySchema = z.object({
  source: z.string().trim().min(2).max(64).optional(),
  limit: z.coerce.number().int().positive().max(2000).optional(),
});

const metricAggregateQuerySchema = z.object({
  key: z.string().trim().min(1).max(128),
  source: z.string().trim().min(2).max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  bucket: z.enum(["minute", "hour", "day"]).optional(),
  limit: z.coerce.number().int().positive().max(2000).optional(),
});

const tokenIssueSchema = z.object({
  name: z.string().trim().min(2).max(64),
  scopes: z.array(scopeSchema).min(1).max(32).default(["report:write", "stats:read"]),
  description: z.string().trim().max(255).optional(),
  expiresAt: z.string().datetime().optional(),
  createdBy: z.string().trim().max(64).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const tokenRegisterSchema = tokenIssueSchema.extend({
  tokenHash: z.string().trim().length(64).regex(/^[0-9a-f]+$/i),
});

const revokeTokenParamsSchema = z.object({
  tokenId: z.coerce.number().int().positive(),
});

const reportByIdParamsSchema = z.object({
  reportId: z.coerce.number().int().positive(),
});

function parseDateOrNow(value: string | undefined) {
  if (!value) return new Date();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("INVALID_DATE");
  }
  return parsed;
}

function parseOptionalDate(value: string | undefined) {
  if (!value) return undefined;
  return parseDateOrNow(value);
}

export async function statsRoutes(app: FastifyInstance) {
  const requireReportWrite = requireAuth({ scopes: ["report:write"] });
  const requireStatsRead = requireAuth({ scopes: ["stats:read"] });
  const requireTokensRead = requireAuth({ scopes: ["tokens:read"] });
  const requireTokensWrite = requireAuth({ scopes: ["tokens:write"] });

  app.post(
    "/v1/internal-stats/report",
    { preHandler: [requireReportWrite] },
    async (request) => {
      const input = reportSchema.parse(request.body || {});
      const source = input.source || env.INTERNAL_STATS_DEFAULT_REPORT_SOURCE;
      const capturedAt = parseDateOrNow(input.capturedAt);

      const metrics = input.metrics.map((metric) => ({
        key: metric.key,
        value: metric.value,
        unit: metric.unit,
        tags: metric.tags,
        observedAt: parseDateOrNow(metric.observedAt || input.capturedAt),
      }));

      const result = await storeReport({
        source,
        kind: input.kind,
        capturedAt,
        requestId: input.requestId,
        payload: input.payload,
        metrics,
      });

      return {
        ok: true,
        reportId: result.reportId,
        metricCount: result.metricCount,
      };
    },
  );

  app.post(
    "/v1/internal-stats/report/core/admin-snapshot",
    { preHandler: [requireReportWrite] },
    async (request) => {
      const snapshot = coreAdminSnapshotSchema.parse(request.body || {});
      const source = snapshot.source || env.INTERNAL_STATS_DEFAULT_REPORT_SOURCE;
      const capturedAt = parseDateOrNow(snapshot.generatedAt);
      const database = snapshot.database;

      const metrics = [
        {
          key: "boost.grants.active",
          value: database?.boostGrantsActive,
        },
        {
          key: "boost.badge.members",
          value: database?.boostBadgeMembers,
        },
        {
          key: "boost.stripe.members",
          value: database?.boostStripeMembers,
        },
      ]
        .filter((metric) => Number.isFinite(metric.value))
        .map((metric) => ({
          key: metric.key,
          value: Number(metric.value),
          unit: "count",
          tags: { source: "core-admin-snapshot" },
          observedAt: capturedAt,
        }));

      const result = await storeReport({
        source,
        kind: "core-admin-snapshot",
        capturedAt,
        payload: snapshot as Record<string, unknown>,
        metrics,
      });

      return {
        ok: true,
        reportId: result.reportId,
        metricCount: result.metricCount,
      };
    },
  );

  app.get(
    "/v1/internal-stats/reports/latest",
    { preHandler: [requireStatsRead] },
    async (request, reply) => {
      const query = latestReportQuerySchema.parse(request.query || {});
      const report = await getLatestReport({
        source: query.source,
        kind: query.kind,
      });

      if (!report) {
        return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      }

      return { ok: true, report };
    },
  );

  app.get(
    "/v1/internal-stats/reports",
    { preHandler: [requireStatsRead] },
    async (request) => {
      const query = reportListQuerySchema.parse(request.query || {});
      const reports = await listReports({
        source: query.source,
        kind: query.kind,
        from: parseOptionalDate(query.from),
        to: parseOptionalDate(query.to),
        beforeId: query.beforeId,
        limit: query.limit,
      });

      return {
        ok: true,
        count: reports.length,
        reports,
      };
    },
  );

  app.get(
    "/v1/internal-stats/reports/:reportId",
    { preHandler: [requireStatsRead] },
    async (request, reply) => {
      const params = reportByIdParamsSchema.parse(request.params || {});
      const report = await getReportById(params.reportId);
      if (!report) {
        return reply.code(404).send({ error: "REPORT_NOT_FOUND" });
      }

      return {
        ok: true,
        report,
      };
    },
  );

  app.get(
    "/v1/internal-stats/boost/latest",
    { preHandler: [requireStatsRead] },
    async (request) => {
      const query = latestBoostQuerySchema.parse(request.query || {});
      const snapshot = await getLatestBoostSnapshot(query.source);
      return {
        ok: true,
        boost: snapshot,
      };
    },
  );

  app.get(
    "/v1/internal-stats/metrics/latest",
    { preHandler: [requireStatsRead] },
    async (request, reply) => {
      const query = latestMetricQuerySchema.parse(request.query || {});
      const metric = await getLatestMetric({
        key: query.key,
        source: query.source,
      });
      if (!metric) {
        return reply.code(404).send({ error: "METRIC_NOT_FOUND" });
      }
      return {
        ok: true,
        metric,
      };
    },
  );

  app.get(
    "/v1/internal-stats/metrics/history",
    { preHandler: [requireStatsRead] },
    async (request) => {
      const query = metricHistoryQuerySchema.parse(request.query || {});
      const history = await getMetricHistory({
        key: query.key,
        source: query.source,
        from: parseOptionalDate(query.from),
        to: parseOptionalDate(query.to),
        limit: query.limit,
      });

      return {
        ok: true,
        count: history.length,
        history,
      };
    },
  );

  app.get(
    "/v1/internal-stats/metrics/catalog",
    { preHandler: [requireStatsRead] },
    async (request) => {
      const query = metricCatalogQuerySchema.parse(request.query || {});
      const metrics = await getMetricCatalog({
        source: query.source,
        limit: query.limit,
      });

      return {
        ok: true,
        count: metrics.length,
        metrics,
      };
    },
  );

  app.get(
    "/v1/internal-stats/metrics/aggregate",
    { preHandler: [requireStatsRead] },
    async (request) => {
      const query = metricAggregateQuerySchema.parse(request.query || {});
      const buckets = await getMetricAggregate({
        key: query.key,
        source: query.source,
        from: parseOptionalDate(query.from),
        to: parseOptionalDate(query.to),
        bucket: query.bucket,
        limit: query.limit,
      });

      return {
        ok: true,
        bucket: query.bucket || "hour",
        count: buckets.length,
        buckets,
      };
    },
  );

  app.get(
    "/v1/internal-stats/runtime",
    { preHandler: [requireStatsRead] },
    async () => {
      return {
        ok: true,
        runtime: getRequestStatsSnapshot(),
      };
    },
  );

  app.post(
    "/v1/internal-stats/auth/tokens/issue",
    { preHandler: [requireGenSecret()] },
    async (request) => {
      const input = tokenIssueSchema.parse(request.body || {});
      const rawToken = generateRawApiToken();
      const tokenHash = hashRawApiToken(rawToken);

      await createApiTokenRecord({
        name: input.name,
        tokenHash,
        scopes: input.scopes,
        description: input.description,
        createdBy: input.createdBy || "gen-secret",
        expiresAt: parseOptionalDate(input.expiresAt),
        metadata: input.metadata,
      });

      return {
        ok: true,
        token: rawToken,
        tokenHash,
        scopes: input.scopes,
      };
    },
  );

  app.post(
    "/v1/internal-stats/auth/tokens/register",
    { preHandler: [requireGenSecret()] },
    async (request) => {
      const input = tokenRegisterSchema.parse(request.body || {});
      await createApiTokenRecord({
        name: input.name,
        tokenHash: input.tokenHash.toLowerCase(),
        scopes: input.scopes,
        description: input.description,
        createdBy: input.createdBy || "gen-secret",
        expiresAt: parseOptionalDate(input.expiresAt),
        metadata: input.metadata,
      });

      return {
        ok: true,
        tokenHash: input.tokenHash.toLowerCase(),
      };
    },
  );

  app.get(
    "/v1/internal-stats/auth/tokens",
    { preHandler: [requireTokensRead] },
    async () => {
      const tokens = await listApiTokens();
      return {
        ok: true,
        count: tokens.length,
        tokens,
      };
    },
  );

  app.post(
    "/v1/internal-stats/auth/tokens/:tokenId/revoke",
    { preHandler: [requireTokensWrite] },
    async (request) => {
      const params = revokeTokenParamsSchema.parse(request.params || {});
      await revokeApiToken(params.tokenId);
      return {
        ok: true,
        revokedTokenId: params.tokenId,
      };
    },
  );
}
