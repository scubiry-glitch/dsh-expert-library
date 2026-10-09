-- Deployment identities are stable; disabling advances an optimistic version.
ALTER TABLE deployments
  ADD COLUMN state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE FUNCTION guard_deployment_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'deployment identity is immutable';
  END IF;
  IF NEW.state_version <> OLD.state_version + 1 THEN
    RAISE EXCEPTION 'deployment state version must advance exactly once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER deployments_guard BEFORE UPDATE ON deployments FOR EACH ROW EXECUTE FUNCTION guard_deployment_identity();

CREATE INDEX deployment_binding_codes_point_idx ON deployment_binding_codes(deployment_id);
