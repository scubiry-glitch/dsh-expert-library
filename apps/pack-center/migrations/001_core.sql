-- Dedicated schema/search_path are set by the migration runner. Never apply to public.
CREATE DOMAIN center_id AS text CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' AND position('..' IN VALUE) = 0);
CREATE DOMAIN sha256_hex AS text CHECK (VALUE ~ '^[a-f0-9]{64}$');

CREATE TABLE organizations (
  id center_id PRIMARY KEY,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE users (
  id center_id PRIMARY KEY,
  oidc_issuer text NOT NULL CHECK (length(oidc_issuer) BETWEEN 1 AND 2048),
  oidc_subject text NOT NULL CHECK (length(oidc_subject) BETWEEN 1 AND 512),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  platform_admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (oidc_issuer, oidc_subject)
);
CREATE TABLE memberships (
  organization_id center_id NOT NULL REFERENCES organizations(id),
  user_id center_id NOT NULL REFERENCES users(id),
  roles text[] NOT NULL CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['developer','reviewer','admin']::text[]),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE review_scopes (
  reviewer_id center_id NOT NULL REFERENCES users(id),
  organization_id center_id NOT NULL REFERENCES organizations(id),
  granted_by center_id NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (reviewer_id, organization_id)
);
CREATE TABLE invitations (
  id center_id PRIMARY KEY,
  organization_id center_id NOT NULL REFERENCES organizations(id),
  created_by center_id NOT NULL REFERENCES users(id),
  token_sha256 sha256_hex NOT NULL UNIQUE,
  roles text[] NOT NULL CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['developer','reviewer','admin']::text[]),
  expires_at timestamptz NOT NULL,
  accepted_by center_id REFERENCES users(id),
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((accepted_by IS NULL) = (accepted_at IS NULL))
);
CREATE TABLE sessions (
  token_sha256 sha256_hex PRIMARY KEY,
  user_id center_id NOT NULL REFERENCES users(id),
  csrf_sha256 sha256_hex NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE TABLE oidc_login_attempts (
  state_sha256 sha256_hex PRIMARY KEY,
  nonce_sha256 sha256_hex NOT NULL,
  -- PKCE verifier is short-lived encrypted credential material, not cleartext.
  encrypted_verifier text NOT NULL,
  invitation_id center_id REFERENCES invitations(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE packages (
  pack_id center_id PRIMARY KEY,
  owner_org_id center_id NOT NULL REFERENCES organizations(id),
  created_by center_id NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (pack_id, owner_org_id)
);
CREATE TABLE submissions (
  id center_id PRIMARY KEY,
  owner_org_id center_id NOT NULL REFERENCES organizations(id),
  pack_id center_id NOT NULL,
  author_id center_id NOT NULL REFERENCES users(id),
  version text NOT NULL CHECK (length(version) BETWEEN 5 AND 200),
  source_url text NOT NULL CHECK (source_url LIKE 'https://%' AND length(source_url) <= 2048),
  source_ref text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 256),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 20000),
  license text NOT NULL DEFAULT '' CHECK (length(license) <= 1000),
  distribution jsonb NOT NULL CHECK (jsonb_typeof(distribution) = 'object' AND distribution ? 'kind' AND distribution->>'kind' IN ('organization','selected','authenticated')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validating','validation_failed','validated','pending_review','approved','changes_requested','rejected','withdrawn')),
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  previous_submission_id center_id REFERENCES submissions(id),
  snapshot_id center_id,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (pack_id, owner_org_id) REFERENCES packages(pack_id, owner_org_id),
  UNIQUE (id, owner_org_id, pack_id),
  UNIQUE (id, owner_org_id, pack_id, version),
  FOREIGN KEY (previous_submission_id, owner_org_id, pack_id) REFERENCES submissions(id, owner_org_id, pack_id),
  CHECK (status NOT IN ('validated','pending_review','approved','changes_requested','rejected','withdrawn') OR snapshot_id IS NOT NULL)
);
CREATE INDEX submissions_org_status_idx ON submissions(owner_org_id, status, created_at);
CREATE TABLE submission_snapshots (
  id center_id PRIMARY KEY,
  submission_id center_id NOT NULL UNIQUE REFERENCES submissions(id),
  source_commit text NOT NULL CHECK (source_commit ~ '^[a-f0-9]{40}([a-f0-9]{24})?$'),
  artifact_sha256 sha256_hex NOT NULL,
  content_tree_sha256 sha256_hex NOT NULL,
  report_sha256 sha256_hex NOT NULL,
  artifact_key text NOT NULL CHECK (length(artifact_key) BETWEEN 1 AND 2048),
  report_key text NOT NULL CHECK (length(report_key) BETWEEN 1 AND 2048),
  validator_version text NOT NULL,
  normalization_version integer NOT NULL CHECK (normalization_version > 0),
  pack_schema_version integer NOT NULL CHECK (pack_schema_version > 0),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 9007199254740991),
  file_count integer NOT NULL CHECK (file_count > 0),
  report jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  preview jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(preview) = 'object'),
  diff jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(diff) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, submission_id)
);
ALTER TABLE submissions ADD CONSTRAINT submission_snapshot_identity_fk FOREIGN KEY (snapshot_id, id) REFERENCES submission_snapshots(id, submission_id);
CREATE TABLE validation_attempts (
  id center_id PRIMARY KEY,
  submission_id center_id NOT NULL REFERENCES submissions(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  snapshot_id center_id REFERENCES submission_snapshots(id),
  error_code text,
  error_message text CHECK (length(error_message) <= 4000),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  UNIQUE (submission_id, attempt)
);
CREATE TABLE reviews (
  id center_id PRIMARY KEY,
  submission_id center_id NOT NULL UNIQUE REFERENCES submissions(id),
  snapshot_id center_id NOT NULL,
  reviewer_id center_id NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('approved','changes_requested','rejected')),
  expected_state_version integer NOT NULL CHECK (expected_state_version > 0),
  content_tree_sha256 sha256_hex NOT NULL,
  comment text NOT NULL CHECK (length(comment) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (snapshot_id, submission_id) REFERENCES submission_snapshots(id, submission_id)
);
CREATE TABLE releases (
  id center_id PRIMARY KEY,
  pack_id center_id NOT NULL,
  owner_org_id center_id NOT NULL,
  version text NOT NULL,
  approved_submission_id center_id NOT NULL UNIQUE,
  snapshot_id center_id NOT NULL,
  status text NOT NULL DEFAULT 'publishing' CHECK (status IN ('publishing','publish_failed','published','yanked')),
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  signed_manifest jsonb CHECK (signed_manifest IS NULL OR jsonb_typeof(signed_manifest) = 'object'),
  error_code text,
  yank_reason text CHECK (length(yank_reason) <= 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  yanked_at timestamptz,
  UNIQUE (pack_id, version),
  FOREIGN KEY (approved_submission_id, owner_org_id, pack_id, version) REFERENCES submissions(id, owner_org_id, pack_id, version),
  FOREIGN KEY (snapshot_id, approved_submission_id) REFERENCES submission_snapshots(id, submission_id),
  CHECK (status NOT IN ('published','yanked') OR (signed_manifest IS NOT NULL AND published_at IS NOT NULL)),
  CHECK (status <> 'yanked' OR (yanked_at IS NOT NULL AND length(yank_reason) > 0))
);
CREATE TABLE release_distribution (
  release_id center_id PRIMARY KEY REFERENCES releases(id),
  scope jsonb NOT NULL CHECK (jsonb_typeof(scope) = 'object' AND scope ? 'kind' AND scope->>'kind' IN ('organization','selected','authenticated')),
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE distribution_reviews (
  id center_id PRIMARY KEY,
  release_id center_id NOT NULL REFERENCES releases(id),
  requested_by center_id NOT NULL REFERENCES users(id),
  requested_scope jsonb NOT NULL CHECK (jsonb_typeof(requested_scope) = 'object'),
  expected_state_version integer NOT NULL CHECK (expected_state_version > 0),
  status text NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review','approved','rejected','withdrawn')),
  reviewed_by center_id REFERENCES users(id),
  comment text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  reviewed_at timestamptz,
  CHECK (reviewed_by IS NULL OR reviewed_by <> requested_by)
);

CREATE TABLE deployments (
  id center_id PRIMARY KEY,
  organization_id center_id NOT NULL REFERENCES organizations(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_by center_id NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE deployment_binding_codes (
  id center_id PRIMARY KEY,
  deployment_id center_id NOT NULL REFERENCES deployments(id),
  code_sha256 sha256_hex NOT NULL UNIQUE,
  created_by center_id NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE deployment_credentials (
  id center_id PRIMARY KEY,
  deployment_id center_id NOT NULL REFERENCES deployments(id),
  token_sha256 sha256_hex NOT NULL UNIQUE,
  scopes text[] NOT NULL DEFAULT ARRAY['catalog:read','release:download'] CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['catalog:read','release:download']::text[]),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX deployment_credentials_point_idx ON deployment_credentials(deployment_id);
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human','deployment','system')),
  actor_id center_id NOT NULL,
  organization_id center_id REFERENCES organizations(id),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  object_kind text NOT NULL,
  object_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('succeeded','denied','failed')),
  details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_object_idx ON audit_events(object_kind, object_id, created_at);
CREATE TABLE request_idempotency (
  principal_key text NOT NULL,
  operation_key text NOT NULL,
  request_sha256 sha256_hex NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (principal_key, operation_key)
);

CREATE TABLE jobs (
  id center_id PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('validate_submission','publish_release')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_sha256 sha256_hex NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  result jsonb,
  error_code text,
  error_message text CHECK (length(error_message) <= 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (kind, idempotency_key),
  CHECK ((status = 'running') = (lease_owner IS NOT NULL AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (status = 'running' OR (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL))
);
CREATE INDEX jobs_ready_idx ON jobs(available_at, created_at) WHERE status IN ('queued','running');
CREATE TABLE job_attempts (
  job_id center_id NOT NULL REFERENCES jobs(id),
  attempt integer NOT NULL CHECK (attempt > 0),
  lease_token uuid NOT NULL UNIQUE,
  worker_id text NOT NULL,
  outcome text NOT NULL DEFAULT 'running' CHECK (outcome IN ('running','succeeded','failed','lease_expired')),
  error_code text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  PRIMARY KEY (job_id, attempt)
);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record: %', TG_TABLE_NAME USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER immutable_snapshot BEFORE UPDATE OR DELETE ON submission_snapshots FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER immutable_review BEFORE UPDATE OR DELETE ON reviews FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER append_only_audit BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE FUNCTION guard_package_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.pack_id, NEW.owner_org_id, NEW.created_by) IS DISTINCT FROM (OLD.pack_id, OLD.owner_org_id, OLD.created_by) THEN
    RAISE EXCEPTION 'package ownership is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_package_identity BEFORE UPDATE ON packages FOR EACH ROW EXECUTE FUNCTION guard_package_identity();

CREATE FUNCTION guard_submission_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.owner_org_id, NEW.pack_id, NEW.author_id, NEW.previous_submission_id) IS DISTINCT FROM (OLD.id, OLD.owner_org_id, OLD.pack_id, OLD.author_id, OLD.previous_submission_id) THEN
    RAISE EXCEPTION 'submission identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status <> 'draft' AND (NEW.version, NEW.source_url, NEW.source_ref, NEW.notes, NEW.license, NEW.distribution) IS DISTINCT FROM (OLD.version, OLD.source_url, OLD.source_ref, OLD.notes, OLD.license, OLD.distribution) THEN
    RAISE EXCEPTION 'submission source and scope are frozen' USING ERRCODE = '23514';
  END IF;
  IF OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS DISTINCT FROM OLD.snapshot_id THEN
    RAISE EXCEPTION 'submission snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.state_version <> OLD.state_version + 1 THEN RAISE EXCEPTION 'state_version must increment once' USING ERRCODE = '23514'; END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status='draft' AND NEW.status='validating') OR
    (OLD.status='validating' AND NEW.status IN ('validated','validation_failed')) OR
    (OLD.status='validated' AND NEW.status='pending_review') OR
    (OLD.status='pending_review' AND NEW.status IN ('approved','changes_requested','rejected','withdrawn'))
  ) THEN RAISE EXCEPTION 'invalid submission state transition' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_submission_update BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION guard_submission_update();

CREATE FUNCTION guard_review_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submitted submissions%ROWTYPE; snapshot submission_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO STRICT submitted FROM submissions WHERE id = NEW.submission_id FOR UPDATE;
  SELECT * INTO STRICT snapshot FROM submission_snapshots WHERE id = NEW.snapshot_id;
  IF submitted.author_id = NEW.reviewer_id THEN RAISE EXCEPTION 'self review forbidden' USING ERRCODE = '23514'; END IF;
  IF submitted.status <> 'pending_review' OR submitted.state_version <> NEW.expected_state_version OR submitted.snapshot_id <> NEW.snapshot_id OR snapshot.content_tree_sha256 <> NEW.content_tree_sha256 THEN
    RAISE EXCEPTION 'review does not match pending snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_review_insert BEFORE INSERT ON reviews FOR EACH ROW EXECUTE FUNCTION guard_review_insert();

CREATE FUNCTION guard_release_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'releases cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (SELECT 1 FROM submissions s JOIN reviews r ON r.submission_id = s.id WHERE s.id = NEW.approved_submission_id AND s.status = 'approved' AND r.decision = 'approved' AND r.snapshot_id = NEW.snapshot_id) THEN
      RAISE EXCEPTION 'release requires approval of this snapshot' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.id, NEW.pack_id, NEW.owner_org_id, NEW.version, NEW.approved_submission_id, NEW.snapshot_id) IS DISTINCT FROM (OLD.id, OLD.pack_id, OLD.owner_org_id, OLD.version, OLD.approved_submission_id, OLD.snapshot_id)
      OR (OLD.signed_manifest IS NOT NULL AND NEW.signed_manifest IS DISTINCT FROM OLD.signed_manifest) THEN
      RAISE EXCEPTION 'release identity and signed content are immutable' USING ERRCODE = '23514';
    END IF;
    IF NEW.state_version <> OLD.state_version + 1 THEN RAISE EXCEPTION 'state_version must increment once' USING ERRCODE = '23514'; END IF;
    IF NEW.status <> OLD.status AND NOT ((OLD.status='publishing' AND NEW.status IN ('published','publish_failed')) OR (OLD.status='publish_failed' AND NEW.status='publishing') OR (OLD.status='published' AND NEW.status='yanked')) THEN
      RAISE EXCEPTION 'invalid release state transition' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_release_write BEFORE INSERT OR UPDATE OR DELETE ON releases FOR EACH ROW EXECUTE FUNCTION guard_release_write();
