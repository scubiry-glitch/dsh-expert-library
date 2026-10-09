-- Tenancy split: pack creation/management ownership is separated from
-- organization (tenant) membership, and tenant visibility becomes an explicit
-- grant ("see all" or "see a listed subset") instead of following pack ownership.
--
-- Axis 1 (creator): pack_ownerships binds a human user to a pack directly.
-- Axis 2 (tenant): pack_visibilities grants an organization a view of packs.

CREATE TABLE pack_ownerships (
  pack_id center_id NOT NULL REFERENCES packages(pack_id),
  user_id center_id NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner', 'maintainer')),
  granted_by center_id NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (pack_id, user_id)
);
CREATE INDEX pack_ownerships_user_idx ON pack_ownerships(user_id);

CREATE TABLE pack_visibilities (
  id center_id PRIMARY KEY,
  organization_id center_id NOT NULL REFERENCES organizations(id),
  scope text NOT NULL CHECK (scope IN ('all', 'list')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  granted_by center_id NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX pack_visibilities_org_idx ON pack_visibilities(organization_id, status);

CREATE TABLE pack_visibility_items (
  visibility_id center_id NOT NULL REFERENCES pack_visibilities(id),
  pack_id center_id NOT NULL REFERENCES packages(pack_id),
  PRIMARY KEY (visibility_id, pack_id)
);

-- A tenant has at most one effective visibility grant.
CREATE UNIQUE INDEX pack_visibilities_one_active ON pack_visibilities(organization_id)
  WHERE status = 'active';

CREATE FUNCTION guard_pack_visibility_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'pack visibility grants cannot be deleted' USING ERRCODE = '23514'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
    OR NEW.granted_by IS DISTINCT FROM OLD.granted_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pack visibility identity is immutable';
  END IF;
  IF NEW.status <> OLD.status OR NEW.scope <> OLD.scope THEN
    IF NEW.updated_at = OLD.updated_at THEN
      RAISE EXCEPTION 'pack visibility changes must advance updated_at';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guarded_pack_visibility BEFORE UPDATE OR DELETE ON pack_visibilities
  FOR EACH ROW EXECUTE FUNCTION guard_pack_visibility_identity();

-- Backfill axis 1: the package creator becomes the initial owner. Ownership of
-- packs whose creator is no longer an active user still stands; disabling a
-- user account is what revokes effective access, not the ownership row.
INSERT INTO pack_ownerships(pack_id, user_id, role, granted_by)
  SELECT pack_id, created_by, 'owner', created_by FROM packages
  ON CONFLICT (pack_id, user_id) DO NOTHING;
