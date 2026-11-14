-- Repeatable upgrades: team_admin.py applies this file after every init and migrate-integration,
-- so each statement must be safe to run again on both new and existing databases.
-- Existing team RLS and immutable approved records are preserved.

-- Latest attempt only.
ALTER TABLE syncup.conflict_checks ADD COLUMN IF NOT EXISTS diagnostics jsonb
    NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(diagnostics) = 'object');
-- Checkpoints contain approved card IDs and counters only, never tokens or private input.
ALTER TABLE syncup.conflict_checks ADD COLUMN IF NOT EXISTS progress jsonb
    NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object');

-- Team settings every member reads and edits (server/team_settings.py): the project topic all collectors classify
-- by, and the board's goal, scope and rules. One row per team; the latest member to change it is recorded.
CREATE TABLE IF NOT EXISTS syncup.team_settings (
    team_id uuid PRIMARY KEY REFERENCES syncup.teams(id),
    topic text NOT NULL DEFAULT '' CHECK (length(topic) <= 1200),
    goal text NOT NULL DEFAULT '' CHECK (length(goal) <= 500),
    scope text NOT NULL DEFAULT '' CHECK (length(scope) <= 500),
    rules jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rules) = 'array'),
    actor uuid NOT NULL REFERENCES syncup.users(id),
    at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE syncup.team_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.team_settings FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON syncup.team_settings TO syncup_api;
-- The same team-scoped policy as team_decisions.sql: rows of the request's team, for its members only.
DROP POLICY IF EXISTS team_access ON syncup.team_settings;
CREATE POLICY team_access ON syncup.team_settings TO syncup_api
    USING (team_id = nullif(current_setting('syncup.team_id', true), '')::uuid
        AND EXISTS(SELECT 1 FROM syncup.memberships m WHERE m.team_id = team_settings.team_id))
    WITH CHECK (team_id = nullif(current_setting('syncup.team_id', true), '')::uuid
        AND EXISTS(SELECT 1 FROM syncup.memberships m WHERE m.team_id = team_settings.team_id));
DROP POLICY IF EXISTS settings_actor_insert ON syncup.team_settings;
CREATE POLICY settings_actor_insert ON syncup.team_settings AS RESTRICTIVE FOR INSERT TO syncup_api
    WITH CHECK (actor = nullif(current_setting('syncup.user_id', true), '')::uuid);
DROP POLICY IF EXISTS settings_actor_update ON syncup.team_settings;
CREATE POLICY settings_actor_update ON syncup.team_settings AS RESTRICTIVE FOR UPDATE TO syncup_api
    USING (true) WITH CHECK (actor = nullif(current_setting('syncup.user_id', true), '')::uuid);
