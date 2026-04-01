CREATE TABLE IF NOT EXISTS internal_stats_reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_service VARCHAR(64) NOT NULL,
  report_kind VARCHAR(64) NOT NULL,
  captured_at DATETIME(3) NOT NULL,
  received_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  request_id VARCHAR(64) NULL,
  payload_json JSON NULL,
  PRIMARY KEY (id),
  KEY idx_internal_stats_reports_source_kind_captured (source_service, report_kind, captured_at),
  KEY idx_internal_stats_reports_received_at (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS internal_stats_report_metrics (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_id BIGINT UNSIGNED NOT NULL,
  source_service VARCHAR(64) NOT NULL,
  metric_key VARCHAR(128) NOT NULL,
  metric_value DOUBLE NOT NULL,
  metric_unit VARCHAR(32) NULL,
  metric_tags_json JSON NULL,
  observed_at DATETIME(3) NOT NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_internal_stats_metrics_lookup (source_service, metric_key, observed_at),
  KEY idx_internal_stats_metrics_report_id (report_id),
  CONSTRAINT fk_internal_stats_report_metrics_report
    FOREIGN KEY (report_id)
    REFERENCES internal_stats_reports (id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;

CREATE TABLE IF NOT EXISTS internal_stats_metric_latest (
  source_service VARCHAR(64) NOT NULL,
  metric_key VARCHAR(128) NOT NULL,
  metric_value DOUBLE NOT NULL,
  metric_unit VARCHAR(32) NULL,
  metric_tags_json JSON NULL,
  observed_at DATETIME(3) NOT NULL,
  updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (source_service, metric_key),
  KEY idx_internal_stats_metric_latest_observed_at (observed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
