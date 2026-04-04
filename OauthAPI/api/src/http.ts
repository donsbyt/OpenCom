import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";

import { HealthRoutes } from "./routes/health";
import { env } from "./env";

export function buildHttp() {
  const app = Fastify({
    logger: { level: env.INTERNAL_STATS_LOG_LEVEL },
  });

  app.register(cors, { origin: true, credentials: true });
  app.register(rateLimit, { max: 600, timeWindow: "1 minute" });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        issues: error.issues,
      });
    }

    request.log.error({ err: error }, "Unhandled request error");
    return reply.code(500).send({ error: "INTERNAL_SERVER_ERROR" });
  });

  app.register(HealthRoutes);

  return app;
}