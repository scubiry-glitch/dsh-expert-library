-- Functional authorization: a single global account spans organizations, and
-- organization membership carries only functional roles. Package creation
-- authority lives in pack_ownerships (migration 007), so the tenant-level
-- 'developer' role is retired: it granted write access that no longer exists.

-- Drop the old checks first: existing rows hold 'developer', which neither
-- the old nor the new constraint pair would allow during the rewrite.
ALTER TABLE memberships DROP CONSTRAINT memberships_roles_check;
ALTER TABLE invitations DROP CONSTRAINT invitations_roles_check;

-- Data migration: 'developer' becomes 'member'; existing admin/reviewer rows
-- keep their functional roles and gain plain membership.
UPDATE memberships SET roles = array_replace(roles, 'developer', 'member');
UPDATE invitations SET roles = array_replace(roles, 'developer', 'member');

ALTER TABLE memberships ADD CONSTRAINT memberships_roles_check
  CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['admin','reviewer','member']::text[]);
ALTER TABLE invitations ADD CONSTRAINT invitations_roles_check
  CHECK (cardinality(roles) > 0 AND roles <@ ARRAY['admin','reviewer','member']::text[]);
