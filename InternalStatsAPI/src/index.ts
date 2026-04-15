import { pool } from "./db.js";
import { env, internalStatsEnvFilePath } from "./env.js";
import { buildHttp } from "./http.js";
import { pruneReportsOlderThan } from "./statsStore.js";

const app = buildHttp();
let isShuttingDown = false;
let retentionTimer: NodeJS.Timeout | null = null;

async function runRetentionSweep() {
  const cutoff = new Date(
    Date.now() - env.INTERNAL_STATS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  let deletedTotal = 0;
  while (true) {
    const deleted = await pruneReportsOlderThan(cutoff);
    deletedTotal += deleted;
    if (deleted < 5000) break;
  }

  if (deletedTotal > 0) {
    app.log.info(
      {
        cutoff: cutoff.toISOString(),
        deletedReports: deletedTotal,
      },
      "Retention sweep deleted old stats reports",
    );
  }
}

function startRetentionSchedule() {
  const intervalMs = env.INTERNAL_STATS_RETENTION_SWEEP_MINUTES * 60 * 1000;

  void runRetentionSweep().catch((error) => {
    app.log.error({ err: error }, "Initial retention sweep failed");
  });

  retentionTimer = setInterval(() => {
    void runRetentionSweep().catch((error) => {
      app.log.error({ err: error }, "Retention sweep failed");
    });
  }, intervalMs);
}

async function shutdown(reason: string, requestedExitCode = 0) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }

  let exitCode = requestedExitCode;
  app.log.info({ reason }, "Shutting down internal stats server");

  try {
    await app.close();
  } catch (error) {
    exitCode = 1;
    app.log.error({ err: error }, "Failed to close Fastify server");
  }

  try {
    await pool.end();
  } catch (error) {
    exitCode = 1;
    app.log.error({ err: error }, "Failed to close MySQL pool");
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
  app.log.info(
    {
      envFile: internalStatsEnvFilePath,
      host: env.INTERNAL_STATS_HOST,
      port: env.INTERNAL_STATS_PORT,
      dbHost: env.DB_HOST,
      dbName: env.DB_NAME,
      authRequired: env.INTERNAL_STATS_REQUIRE_AUTH,
      syncSecretHeader: env.INTERNAL_STATS_SYNC_SECRET_HEADER,
      apiTokenHeader: env.INTERNAL_STATS_API_TOKEN_HEADER,
      tokenBootstrapEnabled: Boolean(env.INTERNAL_STATS_GEN_SECRET),
      tokenBootstrapHeader: env.INTERNAL_STATS_GEN_SECRET_HEADER,
      retentionDays: env.INTERNAL_STATS_RETENTION_DAYS,
      retentionSweepMinutes: env.INTERNAL_STATS_RETENTION_SWEEP_MINUTES,
    },
    "Starting internal stats server",
  );

  await app.listen({
    port: env.INTERNAL_STATS_PORT,
    host: env.INTERNAL_STATS_HOST,
  });

  startRetentionSchedule();
}

start().catch((error) => {
  app.log.error({ err: error }, "Internal stats server failed to start");
  void shutdown("STARTUP_FAILURE", 1);
});
