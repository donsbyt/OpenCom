import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { pool, q } from "./db.js";

export type MetricInput = {
  key: string;
  value: number;
  unit?: string;
  tags?: Record<string, unknown>;
  observedAt: Date;
};

export type ReportInput = {
  source: string;
  kind: string;
  capturedAt: Date;
  requestId?: string;
  payload?: Record<string, unknown>;
  metrics: MetricInput[];
};

type ReportRow = RowDataPacket & {
  id: number;
  source: string;
  kind: string;
  capturedAt: string;
  receivedAt: string;
  requestId: string | null;
  payloadJson: unknown;
};

type MetricLatestRow = RowDataPacket & {
  source: string;
  key: string;
  value: number;
  unit: string | null;
  tagsJson: unknown;
  observedAt: string;
  updatedAt: string;
};

type MetricHistoryRow = RowDataPacket & {
  metricId: number;
  reportId: number;
  source: string;
  kind: string;
  key: string;
  value: number;
  unit: string | null;
  tagsJson: unknown;
  observedAt: string;
  capturedAt: string;
  receivedAt: string;
};

type MetricCatalogRow = RowDataPacket & {
  key: string;
  source: string;
  sampleCount: number;
  latestObservedAt: string;
  oldestObservedAt: string;
};

type MetricAggregateRow = RowDataPacket & {
  bucketStart: string;
  sampleCount: number;
  minValue: number;
  maxValue: number;
  avgValue: number;
  sumValue: number;
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

function safeJsonStringify(value: unknown) {
  if (value == null) return null;
  return JSON.stringify(value);
}

function toPositiveInt(value: number, fallback: number, max: number) {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.floor(value));
}

export async function storeReport(input: ReportInput) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [reportResult] = await connection.execute<ResultSetHeader>(
      `INSERT INTO internal_stats_reports (
        source_service,
        report_kind,
        captured_at,
        request_id,
        payload_json
      )
      VALUES (?, ?, ?, ?, ?)`,
      [
        input.source,
        input.kind,
        input.capturedAt,
        input.requestId ?? null,
        safeJsonStringify(input.payload ?? null),
      ],
    );

    const reportId = Number(reportResult.insertId || 0);

    if (input.metrics.length > 0) {
      const metricRows = input.metrics.map((metric) => [
        reportId,
        input.source,
        metric.key,
        metric.value,
        metric.unit ?? null,
        safeJsonStringify(metric.tags ?? null),
        metric.observedAt,
      ]);

      await connection.query(
        `INSERT INTO internal_stats_report_metrics (
          report_id,
          source_service,
          metric_key,
          metric_value,
          metric_unit,
          metric_tags_json,
          observed_at
        ) VALUES ?`,
        [metricRows],
      );

      const latestRows = input.metrics.map((metric) => [
        input.source,
        metric.key,
        metric.value,
        metric.unit ?? null,
        safeJsonStringify(metric.tags ?? null),
        metric.observedAt,
      ]);

      await connection.query(
        `INSERT INTO internal_stats_metric_latest (
          source_service,
          metric_key,
          metric_value,
          metric_unit,
          metric_tags_json,
          observed_at
        ) VALUES ?
        ON DUPLICATE KEY UPDATE
          metric_value = VALUES(metric_value),
          metric_unit = VALUES(metric_unit),
          metric_tags_json = VALUES(metric_tags_json),
          observed_at = VALUES(observed_at),
          updated_at = CURRENT_TIMESTAMP(3)`,
        [latestRows],
      );
    }

    await connection.commit();
    return { reportId, metricCount: input.metrics.length };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function getLatestReport(filters: {
  source?: string;
  kind?: string;
}) {
  const clauses: string[] = ["1=1"];
  const params: Record<string, unknown> = {};

  if (filters.source) {
    clauses.push("source_service = :source");
    params.source = filters.source;
  }

  if (filters.kind) {
    clauses.push("report_kind = :kind");
    params.kind = filters.kind;
  }

  const rows = await q<ReportRow>(
    `SELECT
      id,
      source_service AS source,
      report_kind AS kind,
      captured_at AS capturedAt,
      received_at AS receivedAt,
      request_id AS requestId,
      payload_json AS payloadJson
    FROM internal_stats_reports
    WHERE ${clauses.join(" AND ")}
    ORDER BY captured_at DESC, id DESC
    LIMIT 1`,
    params,
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: Number(row.id),
    source: String(row.source),
    kind: String(row.kind),
    capturedAt: row.capturedAt,
    receivedAt: row.receivedAt,
    requestId: row.requestId ? String(row.requestId) : null,
    payload: parseJson<Record<string, unknown>>(row.payloadJson),
  };
}

export async function getReportById(reportId: number) {
  const rows = await q<ReportRow>(
    `SELECT
      id,
      source_service AS source,
      report_kind AS kind,
      captured_at AS capturedAt,
      received_at AS receivedAt,
      request_id AS requestId,
      payload_json AS payloadJson
    FROM internal_stats_reports
    WHERE id = :reportId
    LIMIT 1`,
    { reportId },
  );

  const row = rows[0];
  if (!row) return null;

  return {
    id: Number(row.id),
    source: String(row.source),
    kind: String(row.kind),
    capturedAt: row.capturedAt,
    receivedAt: row.receivedAt,
    requestId: row.requestId ? String(row.requestId) : null,
    payload: parseJson<Record<string, unknown>>(row.payloadJson),
  };
}

export async function listReports(filters: {
  source?: string;
  kind?: string;
  from?: Date;
  to?: Date;
  beforeId?: number;
  limit?: number;
}) {
  const clauses: string[] = ["1=1"];
  const params: Record<string, unknown> = {
    limit: toPositiveInt(filters.limit || 100, 100, 500),
  };

  if (filters.source) {
    clauses.push("source_service = :source");
    params.source = filters.source;
  }
  if (filters.kind) {
    clauses.push("report_kind = :kind");
    params.kind = filters.kind;
  }
  if (filters.from) {
    clauses.push("captured_at >= :from");
    params.from = filters.from;
  }
  if (filters.to) {
    clauses.push("captured_at <= :to");
    params.to = filters.to;
  }
  if (filters.beforeId) {
    clauses.push("id < :beforeId");
    params.beforeId = filters.beforeId;
  }

  const rows = await q<ReportRow>(
    `SELECT
      id,
      source_service AS source,
      report_kind AS kind,
      captured_at AS capturedAt,
      received_at AS receivedAt,
      request_id AS requestId,
      payload_json AS payloadJson
    FROM internal_stats_reports
    WHERE ${clauses.join(" AND ")}
    ORDER BY id DESC
    LIMIT :limit`,
    params,
  );

  return rows.map((row) => ({
    id: Number(row.id),
    source: String(row.source),
    kind: String(row.kind),
    capturedAt: row.capturedAt,
    receivedAt: row.receivedAt,
    requestId: row.requestId ? String(row.requestId) : null,
    payload: parseJson<Record<string, unknown>>(row.payloadJson),
  }));
}

export async function getLatestMetric(filters: {
  key: string;
  source?: string;
}) {
  const clauses: string[] = ["metric_key = :key"];
  const params: Record<string, unknown> = { key: filters.key };

  if (filters.source) {
    clauses.push("source_service = :source");
    params.source = filters.source;
  }

  const rows = await q<MetricLatestRow>(
    `SELECT
      source_service AS source,
      metric_key AS \`key\`,
      metric_value AS value,
      metric_unit AS unit,
      metric_tags_json AS tagsJson,
      observed_at AS observedAt,
      updated_at AS updatedAt
    FROM internal_stats_metric_latest
    WHERE ${clauses.join(" AND ")}
    ORDER BY observed_at DESC
    LIMIT 1`,
    params,
  );

  const row = rows[0];
  if (!row) return null;

  return {
    source: String(row.source),
    key: String(row.key),
    value: Number(row.value),
    unit: row.unit ? String(row.unit) : null,
    tags: parseJson<Record<string, unknown>>(row.tagsJson),
    observedAt: row.observedAt,
    updatedAt: row.updatedAt,
  };
}

export async function getLatestBoostSnapshot(source?: string) {
  const metricKeys = [
    "boost.grants.active",
    "boost.badge.members",
    "boost.stripe.members",
  ];

  const params: Record<string, unknown> = {
    key0: metricKeys[0],
    key1: metricKeys[1],
    key2: metricKeys[2],
  };
  const clauses = ["metric_key IN (:key0, :key1, :key2)"];

  if (source) {
    clauses.push("source_service = :source");
    params.source = source;
  }

  const rows = await q<MetricLatestRow>(
    `SELECT
      source_service AS source,
      metric_key AS \`key\`,
      metric_value AS value,
      metric_unit AS unit,
      metric_tags_json AS tagsJson,
      observed_at AS observedAt,
      updated_at AS updatedAt
    FROM internal_stats_metric_latest
    WHERE ${clauses.join(" AND ")}
    ORDER BY observed_at DESC`,
    params,
  );

  const byKey = new Map(rows.map((row) => [String(row.key), row]));
  const grants = byKey.get("boost.grants.active");
  const badges = byKey.get("boost.badge.members");
  const stripe = byKey.get("boost.stripe.members");

  const latestObservedAt = [grants, badges, stripe]
    .map((metric) => metric?.observedAt ?? null)
    .filter(Boolean)
    .sort()
    .reverse()[0] ?? null;

  return {
    source:
      source ||
      String(grants?.source || badges?.source || stripe?.source || "core-api"),
    observedAt: latestObservedAt,
    boostGrantsActive: grants ? Number(grants.value) : null,
    boostBadgeMembers: badges ? Number(badges.value) : null,
    boostStripeMembers: stripe ? Number(stripe.value) : null,
  };
}

export async function getMetricHistory(filters: {
  key: string;
  source?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}) {
  const clauses: string[] = ["m.metric_key = :key"];
  const params: Record<string, unknown> = {
    key: filters.key,
    limit: toPositiveInt(filters.limit || 200, 200, 2000),
  };

  if (filters.source) {
    clauses.push("m.source_service = :source");
    params.source = filters.source;
  }
  if (filters.from) {
    clauses.push("m.observed_at >= :from");
    params.from = filters.from;
  }
  if (filters.to) {
    clauses.push("m.observed_at <= :to");
    params.to = filters.to;
  }

  const rows = await q<MetricHistoryRow>(
    `SELECT
      m.id AS metricId,
      m.report_id AS reportId,
      m.source_service AS source,
      r.report_kind AS kind,
      m.metric_key AS \`key\`,
      m.metric_value AS value,
      m.metric_unit AS unit,
      m.metric_tags_json AS tagsJson,
      m.observed_at AS observedAt,
      r.captured_at AS capturedAt,
      r.received_at AS receivedAt
    FROM internal_stats_report_metrics m
    JOIN internal_stats_reports r ON r.id = m.report_id
    WHERE ${clauses.join(" AND ")}
    ORDER BY m.observed_at DESC, m.id DESC
    LIMIT :limit`,
    params,
  );

  return rows.map((row) => ({
    metricId: Number(row.metricId),
    reportId: Number(row.reportId),
    source: String(row.source),
    kind: String(row.kind),
    key: String(row.key),
    value: Number(row.value),
    unit: row.unit ? String(row.unit) : null,
    tags: parseJson<Record<string, unknown>>(row.tagsJson),
    observedAt: row.observedAt,
    capturedAt: row.capturedAt,
    receivedAt: row.receivedAt,
  }));
}

export async function getMetricCatalog(filters: {
  source?: string;
  limit?: number;
}) {
  const clauses: string[] = ["1=1"];
  const params: Record<string, unknown> = {
    limit: toPositiveInt(filters.limit || 200, 200, 2000),
  };

  if (filters.source) {
    clauses.push("source_service = :source");
    params.source = filters.source;
  }

  const rows = await q<MetricCatalogRow>(
    `SELECT
      metric_key AS \`key\`,
      source_service AS source,
      COUNT(*) AS sampleCount,
      MAX(observed_at) AS latestObservedAt,
      MIN(observed_at) AS oldestObservedAt
    FROM internal_stats_report_metrics
    WHERE ${clauses.join(" AND ")}
    GROUP BY metric_key, source_service
    ORDER BY sampleCount DESC
    LIMIT :limit`,
    params,
  );

  return rows.map((row) => ({
    key: String(row.key),
    source: String(row.source),
    sampleCount: Number(row.sampleCount),
    latestObservedAt: row.latestObservedAt,
    oldestObservedAt: row.oldestObservedAt,
  }));
}

const BUCKET_SECONDS: Record<string, number> = {
  minute: 60,
  hour: 3600,
  day: 86400,
};

export async function getMetricAggregate(filters: {
  key: string;
  source?: string;
  from?: Date;
  to?: Date;
  bucket?: "minute" | "hour" | "day";
  limit?: number;
}) {
  const bucket = filters.bucket || "hour";
  const bucketSeconds = BUCKET_SECONDS[bucket] || BUCKET_SECONDS.hour;

  const clauses: string[] = ["metric_key = :key"];
  const params: Record<string, unknown> = {
    key: filters.key,
    bucketSeconds,
    limit: toPositiveInt(filters.limit || 200, 200, 2000),
  };

  if (filters.source) {
    clauses.push("source_service = :source");
    params.source = filters.source;
  }
  if (filters.from) {
    clauses.push("observed_at >= :from");
    params.from = filters.from;
  }
  if (filters.to) {
    clauses.push("observed_at <= :to");
    params.to = filters.to;
  }

  const rows = await q<MetricAggregateRow>(
    `SELECT
      FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(observed_at) / :bucketSeconds) * :bucketSeconds) AS bucketStart,
      COUNT(*) AS sampleCount,
      MIN(metric_value) AS minValue,
      MAX(metric_value) AS maxValue,
      AVG(metric_value) AS avgValue,
      SUM(metric_value) AS sumValue
    FROM internal_stats_report_metrics
    WHERE ${clauses.join(" AND ")}
    GROUP BY bucketStart
    ORDER BY bucketStart DESC
    LIMIT :limit`,
    params,
  );

  return rows.map((row) => ({
    bucketStart: row.bucketStart,
    sampleCount: Number(row.sampleCount),
    minValue: Number(row.minValue),
    maxValue: Number(row.maxValue),
    avgValue: Number(row.avgValue),
    sumValue: Number(row.sumValue),
  }));
}

export async function pruneReportsOlderThan(cutoff: Date) {
  const result = await pool.execute<ResultSetHeader>(
    `DELETE FROM internal_stats_reports
     WHERE captured_at < ?
     LIMIT 5000`,
    [cutoff],
  );

  const header = result[0];
  return Number((header as ResultSetHeader).affectedRows || 0);
}
