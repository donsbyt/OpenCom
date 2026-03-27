-- Migration: 0001_create_client_table
-- Description: Creates the client table for tracking downloadable client versions by platform

CREATE TYPE client_platform AS ENUM (
  'windows',
  'linux_deb',
  'linux_rpm',
  'linux_snap',
  'linux_tar',
  'android',
  'ios',
  'macos'
);

CREATE TYPE client_channel AS ENUM (
  'stable',
  'beta',
  'nightly'
);

CREATE TABLE IF NOT EXISTS client (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            client_platform   NOT NULL,
  version         TEXT              NOT NULL,           -- e.g. "1.4.2"
  channel         client_channel    NOT NULL DEFAULT 'stable',
  file_path       TEXT              NOT NULL,           -- relative storage path, e.g. "clients/windows/setup_1.4.2.exe"
  file_name       TEXT              NOT NULL,           -- original filename
  mime_type       TEXT              NOT NULL,           -- e.g. "application/vnd.android.package-archive"
  file_size       BIGINT,                               -- bytes
  checksum_sha256 TEXT,                                 -- SHA-256 hex digest for integrity verification
  download_url    TEXT,                                 -- optional CDN/public URL override
  is_active       BOOLEAN           NOT NULL DEFAULT TRUE,
  release_notes   TEXT,
  uploaded_by     UUID,                                 -- FK to your users table if applicable
  created_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ       NOT NULL DEFAULT NOW()
);

-- Ensure only one active build per platform+channel combo
CREATE UNIQUE INDEX uq_client_active_version
  ON client (type, channel, version)
  WHERE is_active = TRUE;

-- Speed up lookups by platform + channel (e.g. "give me the latest stable windows build")
CREATE INDEX idx_client_type_channel ON client (type, channel, created_at DESC);

-- Auto-update updated_at on row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_client_updated_at
  BEFORE UPDATE ON client
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
