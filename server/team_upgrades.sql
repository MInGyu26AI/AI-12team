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

-- === 팀별 노션 페이지 연결 (server/notion_sync.py link_request) ==================================================
-- The Notion page a team links from the web: any active member may link or unlink, and the latest one is recorded.
-- The token is a secret: the API never returns it, and unlinking clears it. When no active row exists, the server's
-- SYNCUP_NOTION_* environment link (one team) still applies.
CREATE TABLE IF NOT EXISTS syncup.team_notion_links (
    team_id uuid PRIMARY KEY REFERENCES syncup.teams(id),
    page_id uuid NOT NULL,
    token text NOT NULL DEFAULT '' CHECK (length(token) <= 500),
    title text NOT NULL DEFAULT '' CHECK (length(title) <= 200),
    active boolean NOT NULL DEFAULT true,
    actor uuid NOT NULL REFERENCES syncup.users(id),
    actor_name text NOT NULL DEFAULT '' CHECK (length(actor_name) <= 200),  -- other members' names are not readable
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (NOT active OR length(token) >= 20)
);
ALTER TABLE syncup.team_notion_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.team_notion_links FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON syncup.team_notion_links TO syncup_api;
DROP POLICY IF EXISTS team_access ON syncup.team_notion_links;
CREATE POLICY team_access ON syncup.team_notion_links TO syncup_api
    USING (team_id = nullif(current_setting('syncup.team_id', true), '')::uuid
        AND EXISTS(SELECT 1 FROM syncup.memberships m WHERE m.team_id = team_notion_links.team_id))
    WITH CHECK (team_id = nullif(current_setting('syncup.team_id', true), '')::uuid
        AND EXISTS(SELECT 1 FROM syncup.memberships m WHERE m.team_id = team_notion_links.team_id));
DROP POLICY IF EXISTS notion_link_actor_insert ON syncup.team_notion_links;
CREATE POLICY notion_link_actor_insert ON syncup.team_notion_links AS RESTRICTIVE FOR INSERT TO syncup_api
    WITH CHECK (actor = nullif(current_setting('syncup.user_id', true), '')::uuid);
DROP POLICY IF EXISTS notion_link_actor_update ON syncup.team_notion_links;
CREATE POLICY notion_link_actor_update ON syncup.team_notion_links AS RESTRICTIVE FOR UPDATE TO syncup_api
    USING (true) WITH CHECK (actor = nullif(current_setting('syncup.user_id', true), '')::uuid);
-- === 팀별 노션 페이지 연결 끝 ===

-- --- 7-1 팀 GitHub 레포 연결 (feat/team-repo-link) ---
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

-- ── 초대 링크 (server/team_invites.py, docs/team-server.md '초대 링크로 팀에 참여') ─────────────────────────────────
-- Any active member makes a link to their own team; who made it and when are kept, and there is no role column.
-- One link serves many people for 7 days, until the team has 8 active members or any member revokes it. Whoever
-- opens it logs in with GitHub on the web (key_issue.py): a login no identity row knows becomes a new user with that
-- identity, a known user only gets the membership, and either gets a web key from issue_web_key in the same
-- transaction. The API makes the 144-bit code and passes only its SHA-256, so no table keeps the code. The validity,
-- the member limit and the number of open links are fixed in the functions below, not passed in.
CREATE TABLE IF NOT EXISTS syncup.invites (
    id uuid PRIMARY KEY,
    team_id uuid NOT NULL REFERENCES syncup.teams(id),
    code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    created_by uuid NOT NULL REFERENCES syncup.users(id),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_by uuid REFERENCES syncup.users(id),
    revoked_at timestamptz,
    CHECK ((revoked_by IS NULL) = (revoked_at IS NULL))
);
CREATE INDEX IF NOT EXISTS invites_by_team ON syncup.invites (team_id, created_at);
-- Every join that reached the database. No code, code hash, provider user ID or IP: an unknown link keeps only the
-- outcome, and a login that made no user keeps no user.
CREATE TABLE IF NOT EXISTS syncup.invite_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT clock_timestamp(),
    invite_id uuid REFERENCES syncup.invites(id),
    outcome text NOT NULL CHECK (outcome IN ('joined', 'member', 'unknown_link', 'expired', 'revoked', 'team_full',
        'removed', 'unknown', 'ambiguous', 'inactive', 'limited', 'reused', 'full')),
    user_id uuid REFERENCES syncup.users(id)
);
-- Row security with no policy and no grant, as for identities: the API role uses the functions below only.
ALTER TABLE syncup.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.invites FORCE ROW LEVEL SECURITY;
ALTER TABLE syncup.invite_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.invite_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON syncup.invites, syncup.invite_events FROM PUBLIC;

-- The most active members a link fills a team to. The functions below only; the API role cannot call it.
CREATE OR REPLACE FUNCTION syncup.team_member_limit() RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT 8 $$;
REVOKE ALL ON FUNCTION syncup.team_member_limit() FROM PUBLIC;

-- Active members (active user, active membership) of p_team.
CREATE OR REPLACE FUNCTION syncup.team_member_count(p_team uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT count(*)::integer FROM syncup.memberships m JOIN syncup.users u ON u.id = m.user_id
    WHERE m.team_id = p_team AND m.active AND u.active
$$;
REVOKE ALL ON FUNCTION syncup.team_member_count(uuid) FROM PUBLIC;

-- The request's user (team_access.authorized sets syncup.user_id after checking the key) when they are an active
-- member of p_team; insufficient_privilege otherwise, which the API answers with 403. The functions below only.
CREATE OR REPLACE FUNCTION syncup.invite_member(p_team uuid) RETURNS uuid
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_user uuid := nullif(current_setting('syncup.user_id', true), '')::uuid;
BEGIN
    IF v_user IS NULL OR NOT EXISTS (SELECT 1 FROM syncup.memberships m JOIN syncup.users u ON u.id = m.user_id
            WHERE m.team_id = p_team AND m.user_id = v_user AND m.active AND u.active) THEN
        RAISE EXCEPTION 'not an active member of this team' USING ERRCODE = '42501';
    END IF;
    RETURN v_user;
END
$$;
REVOKE ALL ON FUNCTION syncup.invite_member(uuid) FROM PUBLIC;

-- A new link of p_team, made by the request's user. 'too_many' while the team already has 5 open links.
CREATE OR REPLACE FUNCTION syncup.create_invite(p_team uuid, p_code_hash text)
RETURNS TABLE (o_outcome text, o_id uuid, o_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_user uuid;
BEGIN
    IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid invite request' USING ERRCODE = '22023';
    END IF;
    v_user := syncup.invite_member(p_team);
    -- The key team_access.team_lock takes: one team's links, joins and writes change one at a time.
    PERFORM pg_advisory_xact_lock(hashtextextended(p_team::text, 0));
    IF (SELECT count(*) FROM syncup.invites i WHERE i.team_id = p_team AND i.revoked_at IS NULL
            AND i.expires_at > clock_timestamp()) >= 5 THEN
        o_outcome := 'too_many';
        RETURN NEXT;
        RETURN;
    END IF;
    o_id := gen_random_uuid();
    o_expires_at := clock_timestamp() + interval '7 days';
    INSERT INTO syncup.invites(id, team_id, code_hash, created_by, expires_at)
        VALUES (o_id, p_team, p_code_hash, v_user, o_expires_at);
    o_outcome := 'created';
    RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION syncup.create_invite(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.create_invite(uuid, text) TO syncup_api;

-- p_team's member count and its links of the last 7 days (newest 20), for its members. Never a code or its hash.
CREATE OR REPLACE FUNCTION syncup.list_invites(p_team uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    PERFORM syncup.invite_member(p_team);
    RETURN jsonb_build_object(
        'members', syncup.team_member_count(p_team),
        'member_limit', syncup.team_member_limit(),
        'invites', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                'id', r.id, 'created_by', r.creator, 'created_at', r.created_at, 'expires_at', r.expires_at,
                'revoked_at', r.revoked_at, 'joined', r.joined) ORDER BY r.created_at DESC)
            FROM (SELECT i.id, u.name AS creator, i.created_at, i.expires_at, i.revoked_at,
                         (SELECT count(*) FROM syncup.invite_events e
                          WHERE e.invite_id = i.id AND e.outcome = 'joined') AS joined
                  FROM syncup.invites i JOIN syncup.users u ON u.id = i.created_by
                  WHERE i.team_id = p_team AND i.expires_at > clock_timestamp() - interval '7 days'
                  ORDER BY i.created_at DESC LIMIT 20) r), '[]'::jsonb));
END
$$;
REVOKE ALL ON FUNCTION syncup.list_invites(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.list_invites(uuid) TO syncup_api;

-- Revoke one link of p_team, by any active member. false when p_team has no such link; revoking twice keeps the first.
CREATE OR REPLACE FUNCTION syncup.revoke_invite(p_team uuid, p_invite uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_user uuid;
BEGIN
    v_user := syncup.invite_member(p_team);
    PERFORM pg_advisory_xact_lock(hashtextextended(p_team::text, 0));
    UPDATE syncup.invites i SET revoked_by = v_user, revoked_at = clock_timestamp()
        WHERE i.id = p_invite AND i.team_id = p_team AND i.revoked_at IS NULL;
    RETURN EXISTS (SELECT 1 FROM syncup.invites i WHERE i.id = p_invite AND i.team_id = p_team);
END
$$;
REVOKE ALL ON FUNCTION syncup.revoke_invite(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.revoke_invite(uuid, uuid) TO syncup_api;

-- What the join page shows before the login: the team name and expiry of a usable link, the state of any other.
-- Anyone holding the code may ask (POST /invites/preview, rate limited by the API); nothing else of the team shows.
CREATE OR REPLACE FUNCTION syncup.preview_invite(p_code_hash text)
RETURNS TABLE (o_status text, o_team text, o_expires_at timestamptz, o_members integer, o_member_limit integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_invite syncup.invites;
BEGIN
    SELECT i.* INTO v_invite FROM syncup.invites i WHERE i.code_hash = p_code_hash;
    IF NOT FOUND THEN
        o_status := 'unknown_link';
        RETURN NEXT;
        RETURN;
    END IF;
    o_members := syncup.team_member_count(v_invite.team_id);
    o_member_limit := syncup.team_member_limit();
    o_status := CASE WHEN v_invite.revoked_at IS NOT NULL THEN 'revoked'
                     WHEN v_invite.expires_at <= clock_timestamp() THEN 'expired'
                     WHEN o_members >= o_member_limit THEN 'team_full' ELSE 'valid' END;
    IF o_status = 'valid' THEN
        o_team := (SELECT t.name FROM syncup.teams t WHERE t.id = v_invite.team_id);
        o_expires_at := v_invite.expires_at;
    ELSE
        o_members := NULL;
    END IF;
    RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION syncup.preview_invite(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.preview_invite(text) TO syncup_api;

-- Join p_team of a link with a web login, and register its key. Arguments after p_code_hash are issue_web_key's;
-- p_name names a new user only (a known user keeps the name the team knows). Membership, user and identity rows
-- are made only when issue_web_key issues the key: otherwise they roll back and only the event stays.
-- A change of the result columns needs DROP FUNCTION first.
CREATE OR REPLACE FUNCTION syncup.join_with_invite(p_code_hash text, p_identities jsonb, p_session text,
                                                   p_digest text, p_replaces text, p_device text, p_name text)
RETURNS TABLE (o_outcome text, o_user_id uuid, o_name text, o_expires_at timestamptz, o_team text, o_added boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
    v_invite syncup.invites;
    v_users uuid[];
    v_new boolean;
    v_membership boolean;  -- an existing membership's active flag; NULL when there is none
    v_key record;
BEGIN
    IF p_code_hash IS NULL OR p_code_hash !~ '^[0-9a-f]{64}$' OR p_name IS NULL
            OR length(btrim(p_name)) NOT BETWEEN 1 AND 40 OR jsonb_typeof(p_identities) IS DISTINCT FROM 'array'
            OR jsonb_array_length(p_identities) = 0 THEN
        RAISE EXCEPTION 'invalid invite request' USING ERRCODE = '22023';
    END IF;
    SELECT i.* INTO v_invite FROM syncup.invites i WHERE i.code_hash = p_code_hash;
    IF NOT FOUND THEN
        o_outcome := 'unknown_link';
        INSERT INTO syncup.invite_events(outcome) VALUES (o_outcome);
        RETURN NEXT;
        RETURN;
    END IF;
    -- One team's joins run one at a time, so the member limit cannot be raced past. Read the link again under the
    -- lock: a revoke committed while this join waited counts.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_invite.team_id::text, 0));
    SELECT i.* INTO v_invite FROM syncup.invites i WHERE i.id = v_invite.id;
    SELECT array_agg(DISTINCT i.user_id) INTO v_users
    FROM jsonb_array_elements(p_identities) AS e(value)
    JOIN syncup.identities i ON i.provider = e.value->>'provider' AND i.subject = e.value->>'subject';
    v_new := v_users IS NULL;
    o_user_id := v_users[1];
    IF NOT v_new THEN
        SELECT m.active INTO v_membership FROM syncup.memberships m
        WHERE m.team_id = v_invite.team_id AND m.user_id = o_user_id;
    END IF;
    o_added := v_membership IS NULL;
    IF v_invite.revoked_at IS NOT NULL THEN
        o_outcome := 'revoked';
    ELSIF v_invite.expires_at <= clock_timestamp() THEN
        o_outcome := 'expired';
    ELSIF cardinality(v_users) > 1 THEN
        o_outcome := 'ambiguous';
        o_user_id := NULL;
    ELSIF NOT v_new AND NOT (SELECT u.active FROM syncup.users u WHERE u.id = o_user_id) THEN
        o_outcome := 'inactive';
    ELSIF v_membership IS FALSE THEN
        o_outcome := 'removed';  -- taken out of this team on purpose; only the administrator brings them back
    ELSIF o_added AND syncup.team_member_count(v_invite.team_id) >= syncup.team_member_limit() THEN
        o_outcome := 'team_full';
    END IF;
    IF o_outcome IS NULL THEN
        BEGIN
            IF v_new THEN
                o_user_id := gen_random_uuid();
                INSERT INTO syncup.users(id, name) VALUES (o_user_id, btrim(p_name));
                INSERT INTO syncup.identities(provider, subject, user_id, note)
                    SELECT e.value->>'provider', e.value->>'subject', o_user_id, 'invite'
                    FROM jsonb_array_elements(p_identities) AS e(value);
            END IF;
            IF o_added THEN
                INSERT INTO syncup.memberships(team_id, user_id) VALUES (v_invite.team_id, o_user_id);
            END IF;
            SELECT * INTO v_key FROM syncup.issue_web_key(p_identities, p_session, p_digest, p_replaces, p_device);
            IF v_key.o_outcome <> 'issued' THEN
                RAISE EXCEPTION 'web key not issued' USING ERRCODE = 'SU001';  -- undo this block only
            END IF;
        EXCEPTION WHEN SQLSTATE 'SU001' THEN
            IF v_new THEN
                o_user_id := NULL;  -- the user rolled back with the block
            END IF;
        END;
        IF v_key.o_outcome = 'issued' THEN
            o_outcome := CASE WHEN o_added THEN 'joined' ELSE 'member' END;
            o_name := v_key.o_name;
            o_expires_at := v_key.o_expires_at;
            o_team := (SELECT t.name FROM syncup.teams t WHERE t.id = v_invite.team_id);
        ELSE
            o_outcome := v_key.o_outcome;
        END IF;
    END IF;
    INSERT INTO syncup.invite_events(invite_id, outcome, user_id) VALUES (v_invite.id, o_outcome, o_user_id);
    IF o_outcome NOT IN ('joined', 'member') THEN
        o_user_id := NULL;
        o_added := NULL;
    END IF;
    RETURN NEXT;
END
$$;
REVOKE ALL ON FUNCTION syncup.join_with_invite(text, jsonb, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.join_with_invite(text, jsonb, text, text, text, text, text) TO syncup_api;
