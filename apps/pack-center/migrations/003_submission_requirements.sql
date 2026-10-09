-- Delivery requirements are part of the frozen review input, never chosen later
-- by the publisher or re-resolved silently from a floating dependency version.
ALTER TABLE submissions ADD COLUMN requires_plugin jsonb NOT NULL DEFAULT '{"minVersion":"0.1.0"}'::jsonb
  CHECK (jsonb_typeof(requires_plugin)='object' AND requires_plugin ? 'minVersion');
ALTER TABLE submissions ADD COLUMN dependency_release_ids text[] NOT NULL DEFAULT ARRAY[]::text[]
  CHECK (cardinality(dependency_release_ids) <= 100);
ALTER TABLE submissions ADD COLUMN builtin_dependencies jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(builtin_dependencies)='array' AND jsonb_array_length(builtin_dependencies) <= 100);

CREATE FUNCTION guard_submission_requirements() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.requires_plugin, NEW.dependency_release_ids, NEW.builtin_dependencies)
    IS DISTINCT FROM (OLD.requires_plugin, OLD.dependency_release_ids, OLD.builtin_dependencies) THEN
    RAISE EXCEPTION 'submission delivery requirements are frozen' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER frozen_submission_requirements BEFORE UPDATE ON submissions
  FOR EACH ROW EXECUTE FUNCTION guard_submission_requirements();
