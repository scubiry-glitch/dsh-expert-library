-- Administrators (platform admin, or the owning tenant's admin) may approve
-- their own distribution-scope requests, mirroring the submission self-review
-- exemption. Ordinary reviewers remain barred by the identity check below.
CREATE OR REPLACE FUNCTION guard_distribution_review_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owning_org center_id;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'distribution reviews cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_review' OR NEW.state_version <> 1 OR length(btrim(NEW.reason)) = 0
      OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.comment IS NOT NULL THEN
      RAISE EXCEPTION 'distribution review must begin as an undecided request' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT owner_org_id INTO owning_org FROM releases WHERE id = OLD.release_id;
  IF NEW.reviewed_by = OLD.requested_by AND NEW.reviewed_by IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM users u WHERE u.id = NEW.reviewed_by AND u.status = 'active' AND u.platform_admin
    ) AND NOT EXISTS (
      SELECT 1 FROM memberships m
      WHERE m.user_id = NEW.reviewed_by AND m.organization_id = owning_org
        AND m.status = 'active' AND m.roles @> ARRAY['admin']::text[]
    ) THEN
      RAISE EXCEPTION 'self review forbidden' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF (NEW.id,NEW.release_id,NEW.requested_by,NEW.requested_scope,NEW.expected_state_version,NEW.reason,NEW.created_at)
    IS DISTINCT FROM (OLD.id,OLD.release_id,OLD.requested_by,OLD.requested_scope,OLD.expected_state_version,OLD.reason,OLD.created_at)
    OR OLD.status <> 'pending_review' OR NEW.status NOT IN ('approved','rejected') OR NEW.state_version <> OLD.state_version + 1
    OR NEW.reviewed_by IS NULL OR NEW.reviewed_at IS NULL
    OR NEW.comment IS NULL OR length(btrim(NEW.comment)) = 0 OR length(NEW.comment) > 4000 THEN
    RAISE EXCEPTION 'distribution review is immutable and can only be decided once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- The unnamed table CHECK `reviewed_by IS NULL OR reviewed_by <> requested_by`
-- (001_core) encoded the absolute self-approval ban. Drop it: the replaced
-- guard function above now admits admin self-approval and still bars everyone
-- else, with the decision recorded immutably for audit.
ALTER TABLE distribution_reviews DROP CONSTRAINT distribution_reviews_check;
