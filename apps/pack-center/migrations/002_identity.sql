-- Login state is useless without the independent browser-bound cookie.
ALTER TABLE oidc_login_attempts ADD COLUMN browser_sha256 sha256_hex;
-- No login attempts existed before the identity implementation; fail closed if
-- an old fixture is present instead of inventing a usable cookie binding.
UPDATE oidc_login_attempts SET browser_sha256 = state_sha256, consumed_at = clock_timestamp()
  WHERE browser_sha256 IS NULL;
ALTER TABLE oidc_login_attempts ALTER COLUMN browser_sha256 SET NOT NULL;
CREATE INDEX oidc_login_expiry_idx ON oidc_login_attempts(expires_at);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
