SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'internal_stats_report_metrics'
    AND index_name = 'idx_internal_stats_metrics_key_observed'
);
SET @idx_sql := IF(
  @idx_exists = 0,
  'ALTER TABLE internal_stats_report_metrics ADD KEY idx_internal_stats_metrics_key_observed (metric_key, observed_at)',
  'SELECT 1'
);
PREPARE idx_stmt FROM @idx_sql;
EXECUTE idx_stmt;
DEALLOCATE PREPARE idx_stmt;

SET @idx_exists := (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'internal_stats_report_metrics'
    AND index_name = 'idx_internal_stats_metrics_source_observed'
);
SET @idx_sql := IF(
  @idx_exists = 0,
  'ALTER TABLE internal_stats_report_metrics ADD KEY idx_internal_stats_metrics_source_observed (source_service, observed_at)',
  'SELECT 1'
);
PREPARE idx_stmt FROM @idx_sql;
EXECUTE idx_stmt;
DEALLOCATE PREPARE idx_stmt;
