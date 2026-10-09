-- The developer capability is an account-level functional role (single
-- account, three roles: platform admin / developer / tenant admin). It gates
-- package creation and collaborator grants; write authority per pack still
-- lives in pack_ownerships. Existing creators keep the capability.
ALTER TABLE users ADD COLUMN developer boolean NOT NULL DEFAULT false;
UPDATE users SET developer = true WHERE id IN (
  SELECT user_id FROM pack_ownerships
  UNION
  SELECT created_by FROM packages
);
