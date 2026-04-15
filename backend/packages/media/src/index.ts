import { buildHttp } from "./http.js";
import {
  env,
  mediasoupNetworkingWarnings,
  resolvedMediaServerUrl,
  resolvedMediaWsUrl,
  resolvedMediasoupAnnouncedAddress,
  resolvedMediasoupAnnouncedAddressKind,
  resolvedMediasoupAnnouncedAddressSource,
} from "./env.js";
import { initMediasoup, shutdownMediasoup } from "./voice/mediasoup.js";
import { attachMediaGateway } from "./gateway.js";
import { createLogger } from "./logger.js";
import { pool } from "./db.js";

const logger = createLogger("media");
const app = buildHttp();
let isShuttingDown = false;

async function shutdown(reason: string, requestedExitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  let exitCode = requestedExitCode;
  logger.info("Shutting down media service", { reason });

  try {
    await app.close();
  } catch (error) {
    exitCode = 1;
    logger.error("Failed to close media Fastify server", error);
  }

  try {
    await shutdownMediasoup();
  } catch (error) {
    exitCode = 1;
    logger.error("Failed to shut down mediasoup cleanly", error);
  }

  try {
    await pool.end();
  } catch (error) {
    exitCode = 1;
    logger.error("Failed to close media MySQL pool", error);
  }

  process.exit(exitCode);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

async function start() {
  logger.info("Starting media service", {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    debugHttp: env.DEBUG_HTTP,
    debugVoice: env.DEBUG_VOICE,
    mediaHost: env.MEDIA_HOST,
    mediaPort: env.MEDIA_PORT,
    mediaServerUrl: resolvedMediaServerUrl || "(unset)",
    mediaWsUrl: resolvedMediaWsUrl || "(unset)",
    mediasoupAnnouncedAddress: resolvedMediasoupAnnouncedAddress || "(unset)",
    mediasoupAnnouncedAddressKind: resolvedMediasoupAnnouncedAddressKind,
    mediasoupAnnouncedAddressSource:
      resolvedMediasoupAnnouncedAddressSource || "(unset)",
    mediasoupEnableUdp: env.MEDIASOUP_ENABLE_UDP,
    mediasoupEnableTcp: env.MEDIASOUP_ENABLE_TCP,
    mediasoupPreferUdp: env.MEDIASOUP_PREFER_UDP,
    rtcMinPort: env.MEDIASOUP_RTC_MIN_PORT,
    rtcMaxPort: env.MEDIASOUP_RTC_MAX_PORT,
  });

  if (mediasoupNetworkingWarnings.length) {
    logger.warn("Voice RTC networking warnings detected", {
      warnings: mediasoupNetworkingWarnings,
      listenIp: env.MEDIASOUP_LISTEN_IP,
      announcedAddress: resolvedMediasoupAnnouncedAddress || "(unset)",
      rtcPortRange: `${env.MEDIASOUP_RTC_MIN_PORT}-${env.MEDIASOUP_RTC_MAX_PORT}`,
      protocols: {
        udp: env.MEDIASOUP_ENABLE_UDP,
        tcp: env.MEDIASOUP_ENABLE_TCP,
        preferUdp: env.MEDIASOUP_PREFER_UDP,
      },
    });
  }

  await initMediasoup();
  attachMediaGateway(app);
  await app.listen({ port: env.MEDIA_PORT, host: env.MEDIA_HOST });

  logger.info("Media service listening", {
    host: env.MEDIA_HOST,
    port: env.MEDIA_PORT,
    wsPath: "/gateway",
  });
}

start().catch((error) => {
  logger.error("Media service failed to start", error);
  void shutdown("STARTUP_FAILURE", 1);
});
