-- Scope approval is separate from immutable content approval and release signatures.
ALTER TABLE distribution_reviews
  ADD COLUMN reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 4000),
  ADD COLUMN state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0);

CREATE FUNCTION guard_distribution_review_write() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'distribution reviews cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_review' OR NEW.state_version <> 1 OR length(btrim(NEW.reason)) = 0
      OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL OR NEW.comment IS NOT NULL THEN
      RAISE EXCEPTION 'distribution review must begin as an undecided request' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (NEW.id,NEW.release_id,NEW.requested_by,NEW.requested_scope,NEW.expected_state_version,NEW.reason,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.release_id,OLD.requested_by,OLD.requested_scope,OLD.expected_state_version,OLD.reason,OLD.created_at)
      OR OLD.status <> 'pending_review' OR NEW.status NOT IN ('approved','rejected') OR NEW.state_version <> OLD.state_version + 1
      OR NEW.reviewed_by IS NULL OR NEW.reviewed_by = OLD.requested_by OR NEW.reviewed_at IS NULL
      OR NEW.comment IS NULL OR length(btrim(NEW.comment)) = 0 OR length(NEW.comment) > 4000 THEN
      RAISE EXCEPTION 'distribution review is immutable and can only be decided once' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_distribution_review_write BEFORE INSERT OR UPDATE OR DELETE ON distribution_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_distribution_review_write();

CREATE FUNCTION guard_distribution_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'release distributions cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF NEW.release_id <> OLD.release_id OR NEW.state_version <> OLD.state_version + 1 THEN
    RAISE EXCEPTION 'distribution identity is fixed and its version must increment once' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_distribution_version BEFORE UPDATE OR DELETE ON release_distribution
  FOR EACH ROW EXECUTE FUNCTION guard_distribution_version();
CREATE INDEX distribution_reviews_queue ON distribution_reviews(status,release_id,id);
