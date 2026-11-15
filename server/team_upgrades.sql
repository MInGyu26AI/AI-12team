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

-- Web-issued connection keys (server/key_issue.py, docs/team-server.md '웹 로그인으로 연결 키 받기').
-- A teammate's GitHub login, checked by Supabase Auth, registers the SHA-256 of a key their own PC generated.
-- Existing keys stay admin keys; issued_at of keys issued before this upgrade is the upgrade time.
ALTER TABLE syncup.tokens ADD COLUMN IF NOT EXISTS issued_via text NOT NULL DEFAULT 'admin'
    CHECK (issued_via IN ('admin', 'web'));
ALTER TABLE syncup.tokens ADD COLUMN IF NOT EXISTS issued_at timestamptz NOT NULL DEFAULT now();
-- Login provider user IDs the administrator links to a SyncUp user (team_admin.py identity). Never an email or login name.
CREATE TABLE IF NOT EXISTS syncup.identities (
    provider text NOT NULL CHECK (provider IN ('github', 'google', 'kakao')),
    subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 128),
    user_id uuid NOT NULL REFERENCES syncup.users(id),
    note text NOT NULL DEFAULT '' CHECK (length(note) <= 120),
    PRIMARY KEY (provider, subject)
);
-- Every web issue attempt that reached the database. No key, token, IP or provider user ID: an 'unknown' row keeps
-- only the provider name, because hashing a small GitHub ID would not hide it.
CREATE TABLE IF NOT EXISTS syncup.key_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    outcome text NOT NULL CHECK (outcome IN ('issued', 'unknown', 'ambiguous', 'inactive', 'limited', 'reused', 'full')),
    provider text CHECK (length(provider) <= 40),
    user_id uuid REFERENCES syncup.users(id),
    session_hash text NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
    digest text CHECK (digest ~ '^[0-9a-f]{64}$'),
    device text CHECK (device IN ('macOS', 'Windows'))
);
CREATE UNIQUE INDEX IF NOT EXISTS key_events_one_key_per_login ON syncup.key_events (session_hash) WHERE outcome = 'issued';
-- Row security with no policy and no grant: the API role reaches these tables only through the functions below.
ALTER TABLE syncup.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.identities FORCE ROW LEVEL SECURITY;
ALTER TABLE syncup.key_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.key_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON syncup.identities, syncup.key_events FROM PUBLIC;

-- Register a web key. p_identities are the (provider, subject) pairs the API took from Supabase's answer for this
-- login; p_session is the SHA-256 of its Supabase session id. Every table name is schema-qualified and pg_temp is
-- searched last, so a temporary table cannot stand in for one. Validity (30 days) and the number of active web
-- keys per user (3) are fixed here, not passed in. A change of the result columns needs DROP FUNCTION first.
CREATE OR REPLACE FUNCTION syncup.issue_web_key(p_identities jsonb, p_session text, p_digest text,
                                                p_replaces text, p_device text)
RETURNS TABLE (o_outcome text, o_user_id uuid, o_name text, o_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_users uuid[];
    v_active boolean;
    v_provider text;
BEGIN
    IF jsonb_typeof(p_identities) IS DISTINCT FROM 'array' OR jsonb_array_length(p_identities) = 0
            OR p_session !~ '^[0-9a-f]{64}$' OR p_digest !~ '^[0-9a-f]{64}$'
            OR (p_replaces IS NOT NULL AND p_replaces !~ '^[0-9a-f]{64}$') OR p_device NOT IN ('macOS', 'Windows') THEN
        RAISE EXCEPTION 'invalid web key request' USING ERRCODE = '22023';
    END IF;
    v_provider := p_identities->0->>'provider';
    SELECT array_agg(DISTINCT i.user_id) INTO v_users
    FROM jsonb_array_elements(p_identities) AS e(value)
    JOIN syncup.identities i ON i.provider = e.value->>'provider' AND i.subject = e.value->>'subject';
    IF v_users IS NULL OR cardinality(v_users) <> 1 THEN
        o_outcome := CASE WHEN v_users IS NULL THEN 'unknown' ELSE 'ambiguous' END;
        INSERT INTO syncup.key_events(outcome, provider, session_hash, device)
            VALUES (o_outcome, v_provider, p_session, p_device);
        RETURN NEXT;
        RETURN;
    END IF;
    o_user_id := v_users[1];
    -- One user's issues run one at a time, so the limits below cannot be raced past.
    PERFORM pg_advisory_xact_lock(hashtextextended('syncup.web_key:' || o_user_id::text, 0));
    SELECT u.name, u.active INTO o_name, v_active FROM syncup.users u WHERE u.id = o_user_id;
    IF EXISTS (SELECT 1 FROM syncup.key_events k WHERE k.session_hash = p_session AND k.outcome = 'issued') THEN
        o_outcome := 'reused';
    ELSIF NOT v_active THEN
        o_outcome := 'inactive';
    ELSIF (SELECT count(*) FROM syncup.key_events k WHERE k.user_id = o_user_id AND k.outcome = 'issued'
           AND k.at > clock_timestamp() - interval '1 hour') >= 5 THEN
        o_outcome := 'limited';
    ELSIF (SELECT count(*) FROM syncup.tokens t WHERE t.user_id = o_user_id AND t.issued_via = 'web' AND NOT t.revoked
           AND t.expires_at > clock_timestamp() AND t.digest IS DISTINCT FROM p_replaces) >= 3 THEN
        o_outcome := 'full';
    END IF;
    IF o_outcome IS NOT NULL THEN
        INSERT INTO syncup.key_events(outcome, provider, user_id, session_hash, device)
            VALUES (o_outcome, v_provider, o_user_id, p_session, p_device);
        o_name := NULL;
        RETURN NEXT;
        RETURN;
    END IF;
    -- Only the replaced key of this PC is revoked: a key of the same user's other PC keeps working.
    UPDATE syncup.tokens t SET revoked = true
        WHERE p_replaces IS NOT NULL AND t.digest = p_replaces AND t.user_id = o_user_id AND t.issued_via = 'web';
    o_expires_at := clock_timestamp() + interval '30 days';
    INSERT INTO syncup.tokens(digest, user_id, expires_at, issued_via) VALUES (p_digest, o_user_id, o_expires_at, 'web');
    INSERT INTO syncup.key_events(outcome, provider, user_id, session_hash, digest, device)
        VALUES ('issued', v_provider, o_user_id, p_session, p_digest, p_device);
    o_outcome := 'issued';
    RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION syncup.issue_web_key(jsonb, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.issue_web_key(jsonb, text, text, text, text) TO syncup_api;

-- The answer to a retried request whose first answer was lost: the PC sends the same key digest again, and a web key
-- registered in the last 10 minutes is reported as is. Knowing a digest does not let anyone use the key.
CREATE OR REPLACE FUNCTION syncup.replay_web_key(p_digest text)
RETURNS TABLE (o_user_id uuid, o_name text, o_expires_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT t.user_id, u.name, t.expires_at FROM syncup.tokens t JOIN syncup.users u ON u.id = t.user_id
    WHERE t.digest = p_digest AND t.issued_via = 'web' AND NOT t.revoked AND u.active
      AND t.expires_at > clock_timestamp() AND t.issued_at > clock_timestamp() - interval '10 minutes'
$$;
REVOKE ALL ON FUNCTION syncup.replay_web_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.replay_web_key(text) TO syncup_api;

-- The GitHub repository a team links from the web (server/repo_sync.py link_request): any active member may link or
-- unlink, and the latest one is recorded. The token is a secret: the API never returns it, and unlinking clears it.
-- When no active row exists, the server's SYNCUP_GITHUB_* environment link (one team) still applies.
CREATE TABLE IF NOT EXISTS syncup.team_repo_links (
    team_id uuid PRIMARY KEY REFERENCES syncup.teams(id),
    repo text NOT NULL CHECK (repo ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$'),
    branch text NOT NULL DEFAULT 'main' CHECK (length(branch) BETWEEN 1 AND 200),
    token text NOT NULL DEFAULT '' CHECK (length(token) <= 255),
    private boolean,
    active boolean NOT NULL DEFAULT true,
    actor uuid NOT NULL REFERENCES syncup.users(id),
    actor_name text NOT NULL DEFAULT '' CHECK (length(actor_name) <= 200),  -- other members' names are not readable
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (NOT active OR length(token) >= 20)
);
ALTER TABLE syncup.team_repo_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.team_repo_links FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON syncup.team_repo_links TO syncup_api;
DROP POLICY IF EXISTS team_access ON syncup.team_repo_links;
CREATE POLICY team_access ON syncup.team_repo_links TO syncup_api
    USING (team_id = nullif(current_setting('syncup.team_id', true), '')::uuid
        AND EXISTS(SELECT 1 FROM syncup.memberships m WHERE m.team_id = team_repo_links.team_id))
    WITH CHECK (team_id = nullif(current_setting('syncup.team_id', true), '')::uuid
        AND EXISTS(SELECT 1 FROM syncup.memberships m WHERE m.team_id = team_repo_links.team_id));
DROP POLICY IF EXISTS repo_link_actor_insert ON syncup.team_repo_links;
CREATE POLICY repo_link_actor_insert ON syncup.team_repo_links AS RESTRICTIVE FOR INSERT TO syncup_api
    WITH CHECK (actor = nullif(current_setting('syncup.user_id', true), '')::uuid);
DROP POLICY IF EXISTS repo_link_actor_update ON syncup.team_repo_links;
CREATE POLICY repo_link_actor_update ON syncup.team_repo_links AS RESTRICTIVE FOR UPDATE TO syncup_api
    USING (true) WITH CHECK (actor = nullif(current_setting('syncup.user_id', true), '')::uuid);
