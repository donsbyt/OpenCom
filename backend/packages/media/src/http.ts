import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { env, isMediaOriginAllowed } from "./env.js";
import { createLogger } from "./logger.js";

const logger = createLogger("http");

export function buildHttp() {
  const app = Fastify({
    logger: false,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: true,
  });

  app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      const allowed = isMediaOriginAllowed(origin);
      callback(allowed ? null : new Error("MEDIA_ORIGIN_NOT_ALLOWED"), allowed);
    },
  });
  app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

  if (env.DEBUG_HTTP) {
    app.addHook("onRequest", async (req) => {
      logger.debug("HTTP request", {
        method: req.method,
        url: req.url,
        reqId: req.id,
        origin: req.headers.origin || null,
      });
    });
    app.addHook("onResponse", async (req, rep) => {
      logger.debug("HTTP response", {
        method: req.method,
        url: req.url,
        reqId: req.id,
        statusCode: rep.statusCode,
      });
    });
  }

  app.setErrorHandler((error, req, rep) => {
    logger.error("Unhandled media HTTP error", error, {
      method: req.method,
      url: req.url,
      reqId: req.id,
      origin: req.headers.origin || null,
    });
    if (!rep.sent) rep.status(500).send({ error: "INTERNAL_SERVER_ERROR" });
  });

  return app;
}
