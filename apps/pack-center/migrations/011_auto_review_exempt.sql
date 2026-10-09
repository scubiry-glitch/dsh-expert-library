-- Auto-approval ("免审核") reviews are written under the submitting author's
-- id, which guard_review_insert() would reject as self review for non-admins.
-- Tag such rows explicitly and exempt them: accountability stays in the audit
-- trail (submission.submitted with autoApproved:true, pack.auto_review_configured).
ALTER TABLE reviews ADD COLUMN auto_approve boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION guard_review_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE submitted submissions%ROWTYPE; snapshot submission_snapshots%ROWTYPE;
BEGIN
  SELECT * INTO STRICT submitted FROM submissions WHERE id = NEW.submission_id FOR UPDATE;
  SELECT * INTO STRICT snapshot FROM submission_snapshots WHERE id = NEW.snapshot_id;
  IF submitted.author_id = NEW.reviewer_id AND NOT NEW.auto_approve THEN
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
