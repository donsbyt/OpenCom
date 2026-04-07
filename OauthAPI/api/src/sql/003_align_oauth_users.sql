ALTER TABLE oauth_apps
    DROP FOREIGN KEY fk_oauth_apps_account,
    DROP INDEX idx_oauth_apps_account_id,
    DROP COLUMN account_id,
    ADD COLUMN user_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL AFTER id,
    ADD KEY idx_oauth_apps_user_id (user_id),
    ADD CONSTRAINT fk_oauth_apps_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE;

ALTER TABLE oauth_tokens
    DROP FOREIGN KEY fk_oauth_tokens_account,
    DROP INDEX idx_oauth_tokens_account_id,
    DROP COLUMN account_id,
    ADD COLUMN user_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL AFTER oauth_app_id,
    ADD KEY idx_oauth_tokens_user_id (user_id),
    ADD CONSTRAINT fk_oauth_tokens_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE;

ALTER TABLE oauth_authorization_codes
    DROP FOREIGN KEY fk_oauth_authorization_codes_account,
    DROP INDEX idx_oauth_authorization_codes_account_id,
    DROP COLUMN account_id,
    ADD COLUMN user_id VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL AFTER oauth_app_id,
    ADD KEY idx_oauth_authorization_codes_user_id (user_id),
    ADD CONSTRAINT fk_oauth_authorization_codes_user
        FOREIGN KEY (user_id) REFERENCES users(id)
        ON DELETE CASCADE
        ON UPDATE CASCADE;
