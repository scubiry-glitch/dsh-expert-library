-- Pack-level review exemption ("免审核"): when enabled, submitting a validated
-- snapshot transitions the submission straight to approved and enqueues the
-- publish job, skipping the human review queue. Configured by pack owners or
-- organization reviewers from the review decision panel.
ALTER TABLE packages ADD COLUMN auto_approve boolean NOT NULL DEFAULT false;
