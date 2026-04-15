CREATE TABLE IF NOT EXISTS internal_stats_api_tokens (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_name VARCHAR(64) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  scopes_json JSON NOT NULL,
  description VARCHAR(255) NULL,
  created_by VARCHAR(64) NULL,
  created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  last_used_at DATETIME(3) NULL,
  last_used_ip VARCHAR(64) NULL,
  metadata_json JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_internal_stats_api_tokens_hash (token_hash),
  KEY idx_internal_stats_api_tokens_active (revoked_at, expires_at),
  KEY idx_internal_stats_api_tokens_name (token_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
