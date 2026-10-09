-- Administrators (platform admin, or the owning tenant's admin) may review
-- their own submissions. Application-level checks mirror this exemption; the
-- database guard remains the last line of defense for everyone else.
CREATE OR REPLACE FUNCTION guard_review_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submitted submissions%ROWTYPE; snapshot submission_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO STRICT submitted FROM submissions WHERE id = NEW.submission_id FOR UPDATE;
  SELECT * INTO STRICT snapshot FROM submission_snapshots WHERE id = NEW.snapshot_id;
  IF submitted.author_id = NEW.reviewer_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM users u WHERE u.id = NEW.reviewer_id AND u.status = 'active' AND u.platform_admin
    ) AND NOT EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = NEW.reviewer_id AND m.organization_id = submitted.owner_org_id
        AND m.status = 'active' AND m.roles @> ARRAY['admin']::text[]
    ) THEN
      RAISE EXCEPTION 'self review forbidden' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF submitted.status <> 'pending_review' OR submitted.state_version <> NEW.expected_state_version OR submitted.snapshot_id <> NEW.snapshot_id OR snapshot.content_tree_sha256 <> NEW.content_tree_sha256 THEN
    RAISE EXCEPTION 'review does not match pending snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
