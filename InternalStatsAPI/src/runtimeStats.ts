type RouteMetricState = {
  key: string;
  method: string;
  route: string;
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  lastDurationMs: number;
  errorCount: number;
  lastStatus: number;
  lastSeenAt: string | null;
  samples: number[];
};

const GLOBAL_SAMPLE_LIMIT = 2000;
const ROUTE_SAMPLE_LIMIT = 300;

const requestMetricsByRoute = new Map<string, RouteMetricState>();
const globalDurationSamples: number[] = [];

const globalStatusCounts = {
  success: 0,
  redirect: 0,
  clientError: 0,
  serverError: 0,
};

const serviceStartedAt = Date.now();
let totalRequestCount = 0;
let totalDurationMs = 0;
let maxDurationMs = 0;
let inFlightRequests = 0;

function boundedPush(values: number[], value: number, limit: number) {
  values.push(value);
  if (values.length > limit) values.shift();
}

function roundMetric(value: number, precision = 2) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], targetPercentile: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(
      sorted.length - 1,
      Math.ceil((targetPercentile / 100) * sorted.length) - 1,
    ),
  );
  return sorted[index] ?? 0;
}

export function beginTrackedRequest() {
  inFlightRequests += 1;
  return process.hrtime.bigint();
}

export function recordTrackedRequest(input: {
  startNs: bigint;
  method: string;
  route: string;
  statusCode: number;
}) {
  const durationMs = Number(process.hrtime.bigint() - input.startNs) / 1_000_000;
  const normalizedDurationMs = Math.max(0, durationMs);
  const method = String(input.method || "GET").toUpperCase();
  const route = String(input.route || "/unknown");
  const key = `${method} ${route}`;

  inFlightRequests = Math.max(0, inFlightRequests - 1);
  totalRequestCount += 1;
  totalDurationMs += normalizedDurationMs;
  maxDurationMs = Math.max(maxDurationMs, normalizedDurationMs);
  boundedPush(globalDurationSamples, normalizedDurationMs, GLOBAL_SAMPLE_LIMIT);

  if (input.statusCode >= 500) globalStatusCounts.serverError += 1;
  else if (input.statusCode >= 400) globalStatusCounts.clientError += 1;
  else if (input.statusCode >= 300) globalStatusCounts.redirect += 1;
  else globalStatusCounts.success += 1;

  const current =
    requestMetricsByRoute.get(key) || {
      key,
      method,
      route,
      count: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      lastDurationMs: 0,
      errorCount: 0,
      lastStatus: 0,
      lastSeenAt: null,
      samples: [],
    };

  current.count += 1;
  current.totalDurationMs += normalizedDurationMs;
  current.maxDurationMs = Math.max(current.maxDurationMs, normalizedDurationMs);
  current.lastDurationMs = normalizedDurationMs;
  current.lastStatus = input.statusCode;
  current.lastSeenAt = new Date().toISOString();
  if (input.statusCode >= 400) current.errorCount += 1;
  boundedPush(current.samples, normalizedDurationMs, ROUTE_SAMPLE_LIMIT);
  requestMetricsByRoute.set(key, current);
}

export function getRequestStatsSnapshot() {
  const routes = Array.from(requestMetricsByRoute.values()).map((metric) => {
    const avgMs = metric.count ? metric.totalDurationMs / metric.count : 0;
    const p95Ms = percentile(metric.samples, 95);
    const errorRate = metric.count ? metric.errorCount / metric.count : 0;

    return {
      key: metric.key,
      method: metric.method,
      route: metric.route,
      count: metric.count,
      avgMs: roundMetric(avgMs),
      p95Ms: roundMetric(p95Ms),
      maxMs: roundMetric(metric.maxDurationMs),
      lastMs: roundMetric(metric.lastDurationMs),
      errorCount: metric.errorCount,
      errorRate: roundMetric(errorRate * 100),
      lastStatus: metric.lastStatus,
      lastSeenAt: metric.lastSeenAt,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    startedAt: new Date(serviceStartedAt).toISOString(),
    uptimeSec: roundMetric(process.uptime(), 1),
    inFlight: inFlightRequests,
    totalCount: totalRequestCount,
    avgMs: roundMetric(totalRequestCount ? totalDurationMs / totalRequestCount : 0),
    p95Ms: roundMetric(percentile(globalDurationSamples, 95)),
    maxMs: roundMetric(maxDurationMs),
    routeCount: routes.length,
    statusCounts: { ...globalStatusCounts },
    slowestRoutes: routes
      .filter((route) => route.count > 0)
      .sort((left, right) => {
        if (right.avgMs !== left.avgMs) return right.avgMs - left.avgMs;
        return right.p95Ms - left.p95Ms;
      })
      .slice(0, 8),
    busiestRoutes: routes
      .filter((route) => route.count > 0)
      .sort((left, right) => {
        if (right.count !== left.count) return right.count - left.count;
        return right.avgMs - left.avgMs;
      })
      .slice(0, 8),
    errorRoutes: routes
      .filter((route) => route.errorCount > 0)
      .sort((left, right) => {
        if (right.errorCount !== left.errorCount) return right.errorCount - left.errorCount;
        return right.errorRate - left.errorRate;
      })
      .slice(0, 8),
  };
}
