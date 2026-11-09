-- Run once using the administration connection; the API must use syncup_api.
CREATE SCHEMA syncup;
REVOKE ALL ON SCHEMA syncup FROM PUBLIC;
CREATE TABLE syncup.users (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    active boolean NOT NULL DEFAULT true
);
CREATE TABLE syncup.teams (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120)
);
CREATE TABLE syncup.memberships (
    team_id uuid NOT NULL REFERENCES syncup.teams,
    user_id uuid NOT NULL REFERENCES syncup.users,
    active boolean NOT NULL DEFAULT true,
    PRIMARY KEY (team_id, user_id)
);
CREATE TABLE syncup.tokens (
    digest text PRIMARY KEY CHECK (length(digest) = 64),
    user_id uuid NOT NULL REFERENCES syncup.users,
    expires_at timestamptz NOT NULL,
    revoked boolean NOT NULL DEFAULT false
);
CREATE TABLE syncup.shared_cards (
    team_id uuid NOT NULL REFERENCES syncup.teams,
    id text NOT NULL CHECK (length(id) BETWEEN 1 AND 1200),
    approved_by uuid NOT NULL REFERENCES syncup.users,
    approved_at double precision NOT NULL CHECK (approved_at > 0 AND approved_at < 'Infinity'::float8),
    received_at timestamptz NOT NULL DEFAULT now(),
    packet jsonb NOT NULL CHECK (jsonb_typeof(packet) = 'object' AND packet->>'id' = id),
    PRIMARY KEY (team_id, id)
);

CREATE FUNCTION syncup.authenticate(token_digest text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, syncup
AS $$
    SELECT t.user_id FROM syncup.tokens t JOIN syncup.users u ON u.id = t.user_id
    WHERE t.digest = token_digest AND NOT t.revoked AND t.expires_at > now() AND u.active
$$;
REVOKE ALL ON FUNCTION syncup.authenticate(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.authenticate(text) TO syncup_api;
GRANT USAGE ON SCHEMA syncup TO syncup_api;
GRANT SELECT ON syncup.users, syncup.teams, syncup.memberships, syncup.shared_cards TO syncup_api;
GRANT INSERT ON syncup.shared_cards TO syncup_api;

ALTER TABLE syncup.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.users FORCE ROW LEVEL SECURITY;
CREATE POLICY own_identity ON syncup.users FOR SELECT TO syncup_api
    USING (id = nullif(current_setting('syncup.user_id', true), '')::uuid);

ALTER TABLE syncup.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY own_memberships ON syncup.memberships FOR SELECT TO syncup_api
    USING (user_id = nullif(current_setting('syncup.user_id', true), '')::uuid AND active);

ALTER TABLE syncup.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.teams FORCE ROW LEVEL SECURITY;
CREATE POLICY member_teams ON syncup.teams FOR SELECT TO syncup_api
    USING (EXISTS (SELECT 1 FROM syncup.memberships m WHERE m.team_id = teams.id));

ALTER TABLE syncup.shared_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.shared_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY read_team ON syncup.shared_cards FOR SELECT TO syncup_api
    USING (team_id = nullif(current_setting('syncup.team_id', true), '')::uuid
        AND EXISTS (SELECT 1 FROM syncup.memberships m WHERE m.team_id = shared_cards.team_id));
CREATE POLICY publish_team ON syncup.shared_cards FOR INSERT TO syncup_api
    WITH CHECK (approved_by = nullif(current_setting('syncup.user_id', true), '')::uuid
        AND team_id = nullif(current_setting('syncup.team_id', true), '')::uuid
        AND EXISTS (SELECT 1 FROM syncup.memberships m WHERE m.team_id = shared_cards.team_id));
-- Approved cards are immutable: no UPDATE/DELETE privileges or policies.
