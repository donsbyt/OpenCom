CREATE TABLE IF NOT EXISTS client (
  id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NOT NULL,
  type ENUM('windows','linux_deb','linux_rpm','linux_snap','linux_tar','android','ios','macos') NOT NULL,
  version VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NOT NULL,
  channel ENUM('stable','beta','nightly') NOT NULL DEFAULT 'stable',
  file_path TEXT NOT NULL,
  file_name VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NOT NULL,
  mime_type VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NOT NULL,
  file_size BIGINT UNSIGNED NOT NULL,
  checksum_sha256 VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci DEFAULT NULL,
  download_url TEXT DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  release_notes TEXT DEFAULT NULL,
  uploaded_by VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci DEFAULT NULL,
  active_slot VARCHAR(80)
    GENERATED ALWAYS AS (
      CASE
        WHEN is_active = 1 THEN CONCAT(type, ':', channel)
        ELSE NULL
      END
    ) STORED,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_client_active_slot (active_slot),
  UNIQUE KEY uq_client_version_channel (type, channel, version),
  KEY idx_client_type_channel_created (type, channel, is_active, created_at),
  CONSTRAINT fk_client_uploaded_by
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
