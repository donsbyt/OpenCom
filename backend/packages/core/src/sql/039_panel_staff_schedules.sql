ALTER TABLE support_tickets DROP FOREIGN KEY fk_support_tickets_assigned_to_user;

CREATE TABLE IF NOT EXISTS panel_staff_schedules (
  id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci PRIMARY KEY,
  admin_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NOT NULL,
  shift_date CHAR(10) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  start_time CHAR(5) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  end_time CHAR(5) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  timezone VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NOT NULL DEFAULT 'UTC',
  shift_type VARCHAR(32) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NOT NULL DEFAULT 'support',
  note VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NULL,
  created_by VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NULL,
  updated_by VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_panel_staff_schedules_date_time (shift_date, start_time, end_time),
  INDEX idx_panel_staff_schedules_admin_date (admin_id, shift_date, start_time),
  CONSTRAINT fk_panel_staff_schedules_admin
    FOREIGN KEY (admin_id) REFERENCES panel_admin_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_panel_staff_schedules_created_by
    FOREIGN KEY (created_by) REFERENCES panel_admin_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_panel_staff_schedules_updated_by
    FOREIGN KEY (updated_by) REFERENCES panel_admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_uca1400_ai_ci;
