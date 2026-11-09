-- Repeatable upgrades: team_admin.py applies this file after every init and migrate-integration,
-- so each statement must be safe to run again on both new and existing databases.
-- Existing team RLS and immutable approved records are preserved.

-- Latest attempt only.
ALTER TABLE syncup.conflict_checks ADD COLUMN IF NOT EXISTS diagnostics jsonb
    NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(diagnostics) = 'object');
-- Checkpoints contain approved card IDs and counters only, never tokens or private input.
ALTER TABLE syncup.conflict_checks ADD COLUMN IF NOT EXISTS progress jsonb
    NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object');
