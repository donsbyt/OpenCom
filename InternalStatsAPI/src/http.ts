import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { pool } from "./db.js";
import { env } from "./env.js";
import {
  beginTrackedRequest,
  getRequestStatsSnapshot,
  recordTrackedRequest,
} from "./runtimeStats.js";
import { statsRoutes } from "./routes/stats.js";

export function buildHttp() {
  const app = Fastify({
    logger: { level: env.INTERNAL_STATS_LOG_LEVEL },
    bodyLimit: 4 * 1024 * 1024,
    disableRequestLogging: true,
  });

  app.register(cors, { origin: true, credentials: true });
  app.register(rateLimit, { max: 600, timeWindow: "1 minute" });

  app.addHook("onRequest", async (request) => {
    (request as any)._trackedRequestStartNs = beginTrackedRequest();
  });

  app.addHook("onResponse", async (request, reply) => {
    const startNs = (request as any)._trackedRequestStartNs;
    if (typeof startNs === "bigint") {
      recordTrackedRequest({
        startNs,
        method: request.method,
        route:
          String((request as any).routeOptions?.url || "") ||
          String(request.url || "").split("?")[0] ||
          "/unknown",
        statusCode: reply.statusCode,
      });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        issues: error.issues,
      });
    }

    if ((error as Error)?.message === "INVALID_DATE") {
      return reply.code(400).send({ error: "INVALID_DATE" });
    }

    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send({ error: "INTERNAL_SERVER_ERROR" });
  });

  app.get("/health", async (_request, reply) => {
    try {
      await pool.query("SELECT 1");
      const requestSnapshot = getRequestStatsSnapshot();
      return {
        status: "ok",
        service: "internal-stats-api",
        db: "connected",
        requests: {
          totalCount: requestSnapshot.totalCount,
          uptimeSec: requestSnapshot.uptimeSec,
          routeCount: requestSnapshot.routeCount,
        },
      };
    } catch (error) {
      app.log.error({ err: error }, "Health check DB query failed");
      return reply.code(503).send({
        status: "error",
        service: "internal-stats-api",
        db: "disconnected",
      });
    }
  });

  app.register(statsRoutes);

  return app;
}
