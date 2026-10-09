-- A grant is a short-lived authorization handle, never a public storage URL.
-- Its plaintext is returned once, not placed in audit or idempotency results.
CREATE TABLE download_grants (
  id center_id PRIMARY KEY,
  token_sha256 sha256_hex NOT NULL UNIQUE,
  release_id center_id NOT NULL REFERENCES releases(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','deployment')),
  actor_id center_id NOT NULL,
  credential_id center_id REFERENCES deployment_credentials(id),
  artifact_sha256 sha256_hex NOT NULL,
  manifest_sha256 sha256_hex NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((actor_kind='deployment') = (credential_id IS NOT NULL)),
  CHECK (expires_at>created_at)
);
CREATE INDEX download_grants_release_idx ON download_grants(release_id,expires_at);
CREATE TRIGGER immutable_download_grant BEFORE UPDATE OR DELETE ON download_grants FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
