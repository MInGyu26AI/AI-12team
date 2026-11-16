-- Browser sessions can only read the account and create teams; they are never collector keys.
CREATE TABLE IF NOT EXISTS syncup.onboarding_sessions (
    digest text PRIMARY KEY CHECK (digest ~ '^[0-9a-f]{64}$'),
    user_id uuid NOT NULL REFERENCES syncup.users(id),
    login_hash text NOT NULL UNIQUE CHECK (login_hash ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '30 minutes')
);
CREATE INDEX IF NOT EXISTS onboarding_session_expiry ON syncup.onboarding_sessions(expires_at);
CREATE TABLE IF NOT EXISTS syncup.onboarding_teams (
    user_id uuid NOT NULL REFERENCES syncup.users(id),
    request_id uuid NOT NULL,
    team_id uuid NOT NULL UNIQUE REFERENCES syncup.teams(id),
    name text NOT NULL,
    topic text NOT NULL,
    PRIMARY KEY (user_id, request_id)
);
ALTER TABLE syncup.onboarding_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.onboarding_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE syncup.onboarding_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.onboarding_teams FORCE ROW LEVEL SECURITY;
REVOKE ALL ON syncup.onboarding_sessions, syncup.onboarding_teams FROM PUBLIC, syncup_api;
-- First-login consent (약관 동의). One row per account and document versions; the server's current versions live in
-- onboarding.py (TERMS_VERSION, PRIVACY_VERSION), so a new version needs a new row (re-consent). A repeat call for the
-- same versions keeps the first agreed_at. No IP, user agent or GitHub ID.
CREATE TABLE IF NOT EXISTS syncup.onboarding_consents (
    user_id uuid NOT NULL REFERENCES syncup.users(id),
    terms_version text NOT NULL CHECK (terms_version ~ '^[a-z0-9.-]{1,20}$'),
    privacy_version text NOT NULL CHECK (privacy_version ~ '^[a-z0-9.-]{1,20}$'),
    age14 boolean NOT NULL CHECK (age14),
    transfer boolean NOT NULL CHECK (transfer),
    agreed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, terms_version, privacy_version)
);
ALTER TABLE syncup.onboarding_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.onboarding_consents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON syncup.onboarding_consents FROM PUBLIC, syncup_api;

CREATE OR REPLACE FUNCTION syncup.open_onboarding(p_subject text, p_login text, p_digest text, p_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_name text;
BEGIN
    IF p_subject IS NULL OR p_subject !~ '^[0-9]{1,20}$' OR p_login IS NULL OR p_login !~ '^[0-9a-f]{64}$'
       OR p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' OR p_name IS NULL
       OR length(btrim(p_name)) NOT BETWEEN 1 AND 40 OR p_name ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'invalid onboarding request' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('syncup.onboarding.github:' || p_subject, 0));
    SELECT i.user_id INTO v_user FROM syncup.identities i WHERE i.provider='github' AND i.subject=p_subject;
    IF v_user IS NULL THEN
        v_user := gen_random_uuid();
        INSERT INTO syncup.users(id, name) VALUES (v_user, btrim(p_name));
        INSERT INTO syncup.identities(provider, subject, user_id, note) VALUES ('github', p_subject, v_user, 'self-service');
    END IF;
    SELECT u.name INTO v_name FROM syncup.users u WHERE u.id=v_user AND u.active;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome', 'inactive'); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('syncup.onboarding.user:' || v_user::text, 0));
    DELETE FROM syncup.onboarding_sessions WHERE expires_at <= clock_timestamp();
    IF EXISTS (SELECT 1 FROM syncup.onboarding_sessions WHERE login_hash=p_login) THEN
        RETURN jsonb_build_object('outcome', 'reused');
    END IF;
    IF (SELECT count(*) FROM syncup.onboarding_sessions WHERE user_id=v_user) >= 5 THEN
        RETURN jsonb_build_object('outcome', 'limited');
    END IF;
    INSERT INTO syncup.onboarding_sessions(digest, user_id, login_hash) VALUES (p_digest, v_user, p_login);
    RETURN jsonb_build_object('outcome', 'ready', 'name', v_name);
END $$;
REVOKE ALL ON FUNCTION syncup.open_onboarding(text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.open_onboarding(text,text,text,text) TO syncup_api;

CREATE OR REPLACE FUNCTION syncup.onboarding_account(p_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_name text;
BEGIN
    SELECT u.id, u.name INTO v_user, v_name FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unauthorized'); END IF;
    RETURN jsonb_build_object('outcome','ready','id',v_user,'name',v_name,'teams',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) ORDER BY t.name,t.id)
        FROM syncup.teams t JOIN syncup.memberships m ON m.team_id=t.id
        WHERE m.user_id=v_user AND m.active), '[]'::jsonb),'consents',COALESCE((
        SELECT jsonb_agg(jsonb_build_object('terms',c.terms_version,'privacy',c.privacy_version,
            'at',to_char(c.agreed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')) ORDER BY c.agreed_at)
        FROM syncup.onboarding_consents c WHERE c.user_id=v_user), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION syncup.onboarding_account(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.onboarding_account(text) TO syncup_api;

CREATE OR REPLACE FUNCTION syncup.onboarding_create_team(p_digest text, p_request uuid, p_name text, p_topic text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_team uuid; v_previous syncup.onboarding_teams;
BEGIN
    IF p_request IS NULL OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 80
       OR p_topic IS NULL OR length(btrim(p_topic)) NOT BETWEEN 1 AND 1200 OR p_name ~ '[[:cntrl:]]' THEN
        RAISE EXCEPTION 'invalid team request' USING ERRCODE = '22023';
    END IF;
    SELECT u.id INTO v_user FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unauthorized'); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('syncup.onboarding.user:' || v_user::text, 0));
    IF NOT EXISTS (SELECT 1 FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active) THEN
        RETURN jsonb_build_object('outcome','unauthorized');
    END IF;
    SELECT * INTO v_previous FROM syncup.onboarding_teams WHERE user_id=v_user AND request_id=p_request;
    IF FOUND THEN
        IF v_previous.name <> btrim(p_name) OR v_previous.topic <> btrim(p_topic) THEN
            RETURN jsonb_build_object('outcome','request_conflict');
        END IF;
        RETURN jsonb_build_object('outcome','created','id',v_previous.team_id,'name',v_previous.name);
    END IF;
    IF (SELECT count(*) FROM syncup.onboarding_teams WHERE user_id=v_user) >= 3 THEN
        RETURN jsonb_build_object('outcome','team_limit');
    END IF;
    v_team := gen_random_uuid();
    INSERT INTO syncup.teams(id,name) VALUES (v_team,btrim(p_name));
    INSERT INTO syncup.memberships(team_id,user_id) VALUES (v_team,v_user);
    INSERT INTO syncup.team_settings(team_id,topic,actor) VALUES (v_team,btrim(p_topic),v_user);
    INSERT INTO syncup.onboarding_teams(user_id,request_id,team_id,name,topic)
        VALUES (v_user,p_request,v_team,btrim(p_name),btrim(p_topic));
    RETURN jsonb_build_object('outcome','created','id',v_team,'name',btrim(p_name));
END $$;
REVOKE ALL ON FUNCTION syncup.onboarding_create_team(text,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.onboarding_create_team(text,uuid,text,text) TO syncup_api;

CREATE OR REPLACE FUNCTION syncup.close_onboarding(p_digest text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
    SELECT user_id INTO v_user FROM syncup.onboarding_sessions WHERE digest=p_digest;
    IF v_user IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('syncup.onboarding.user:' || v_user::text, 0));
        DELETE FROM syncup.onboarding_sessions WHERE digest=p_digest;
    END IF;
END $$;
REVOKE ALL ON FUNCTION syncup.close_onboarding(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.close_onboarding(text) TO syncup_api;

CREATE OR REPLACE FUNCTION syncup.onboarding_consent(p_digest text, p_terms text, p_privacy text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
    IF p_terms IS NULL OR p_terms !~ '^[a-z0-9.-]{1,20}$' OR p_privacy IS NULL OR p_privacy !~ '^[a-z0-9.-]{1,20}$' THEN
        RAISE EXCEPTION 'invalid consent request' USING ERRCODE = '22023';
    END IF;
    SELECT u.id INTO v_user FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unauthorized'); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('syncup.onboarding.user:' || v_user::text, 0));
    INSERT INTO syncup.onboarding_consents(user_id,terms_version,privacy_version,age14,transfer)
        VALUES (v_user,p_terms,p_privacy,true,true) ON CONFLICT DO NOTHING;
    RETURN jsonb_build_object('outcome','recorded');
END $$;
REVOKE ALL ON FUNCTION syncup.onboarding_consent(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.onboarding_consent(text,text,text) TO syncup_api;

-- Declining at first login: remove an account that never agreed and has no team. Anything else keeps the account.
-- Rows another feature recorded for it (keys, key/invite events, ...) block the delete through their foreign keys.
CREATE OR REPLACE FUNCTION syncup.onboarding_decline(p_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
    SELECT u.id INTO v_user FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unauthorized'); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('syncup.onboarding.user:' || v_user::text, 0));
    IF EXISTS (SELECT 1 FROM syncup.onboarding_consents WHERE user_id=v_user)
       OR EXISTS (SELECT 1 FROM syncup.memberships WHERE user_id=v_user)
       OR EXISTS (SELECT 1 FROM syncup.onboarding_teams WHERE user_id=v_user) THEN
        RETURN jsonb_build_object('outcome','keep');
    END IF;
    BEGIN
        DELETE FROM syncup.onboarding_sessions WHERE user_id=v_user;
        DELETE FROM syncup.identities WHERE user_id=v_user;
        DELETE FROM syncup.users WHERE id=v_user;
    EXCEPTION WHEN foreign_key_violation THEN
        RETURN jsonb_build_object('outcome','keep');
    END;
    RETURN jsonb_build_object('outcome','deleted','deleted',true);
END $$;
REVOKE ALL ON FUNCTION syncup.onboarding_decline(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.onboarding_decline(text) TO syncup_api;

-- ── 마이페이지 (server/onboarding.py, docs/team-server.md '마이페이지') ─────────────────────────────────────────────
-- Optional profile of the signed-in account: school, major, grade, role and a small photo. The display name stays in
-- syncup.users. Only the functions below touch this table; the API role has no grant.
-- Each CHECK is one plain comparison (NULL passes): pg_dump re-reads an AND nested inside an OR with different
-- parentheses, which would make a restored database differ from the original.
CREATE TABLE IF NOT EXISTS syncup.onboarding_profiles (
    user_id uuid PRIMARY KEY REFERENCES syncup.users(id),
    school text CHECK (school <> '') CHECK (length(school) <= 60) CHECK (school = btrim(school)) CHECK (school !~ '[[:cntrl:]]'),
    major text CHECK (major <> '') CHECK (length(major) <= 60) CHECK (major = btrim(major)) CHECK (major !~ '[[:cntrl:]]'),
    grade text CHECK (grade IN ('1학년','2학년','3학년','4학년','5학년 이상','대학원','기타')),
    role text CHECK (role <> '') CHECK (length(role) <= 80) CHECK (role = btrim(role)) CHECK (role !~ '[[:cntrl:]]'),
    photo bytea CHECK (length(photo) >= 12) CHECK (length(photo) <= 300000),
    photo_type text CHECK (photo_type IN ('image/png','image/jpeg','image/webp')),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((photo IS NULL) = (photo_type IS NULL)),
    CHECK (photo_type IS DISTINCT FROM 'image/png' OR substring(photo FROM 1 FOR 8) = decode('89504e470d0a1a0a', 'hex')),
    CHECK (photo_type IS DISTINCT FROM 'image/jpeg' OR substring(photo FROM 1 FOR 3) = decode('ffd8ff', 'hex')),
    CHECK (photo_type IS DISTINCT FROM 'image/webp' OR substring(photo FROM 1 FOR 4) = decode('52494646', 'hex')),
    CHECK (photo_type IS DISTINCT FROM 'image/webp' OR substring(photo FROM 9 FOR 4) = decode('57454250', 'hex'))
);
ALTER TABLE syncup.onboarding_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.onboarding_profiles FORCE ROW LEVEL SECURITY;
REVOKE ALL ON syncup.onboarding_profiles FROM PUBLIC, syncup_api;

-- Read-only: works without consent. The photo comes back as one-line base64; the API builds the data URL.
CREATE OR REPLACE FUNCTION syncup.onboarding_profile(p_digest text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_name text; v_row syncup.onboarding_profiles; v_subject text;
BEGIN
    SELECT u.id, u.name INTO v_user, v_name FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unauthorized'); END IF;
    SELECT * INTO v_row FROM syncup.onboarding_profiles WHERE user_id=v_user;
    SELECT i.subject INTO v_subject FROM syncup.identities i
        WHERE i.user_id=v_user AND i.provider='github' AND i.subject ~ '^[0-9]{1,20}$' ORDER BY i.subject LIMIT 1;
    RETURN jsonb_build_object('outcome','ready','name',v_name,'school',v_row.school,'major',v_row.major,
        'grade',v_row.grade,'role',v_row.role,'photo_type',v_row.photo_type,
        'photo_b64',translate(encode(v_row.photo,'base64'), E'\n', ''),'github_subject',v_subject,
        'updated_at',to_char(v_row.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
END $$;
REVOKE ALL ON FUNCTION syncup.onboarding_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.onboarding_profile(text) TO syncup_api;

-- Name, school, major, grade and role together (the API checks consent first). Empty text is NULL. A photo is kept.
CREATE OR REPLACE FUNCTION syncup.onboarding_profile_save(p_digest text, p_name text, p_school text, p_major text,
                                                         p_grade text, p_role text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_school text; v_major text; v_role text;
BEGIN
    v_school := nullif(btrim(p_school), ''); v_major := nullif(btrim(p_major), ''); v_role := nullif(btrim(p_role), '');
    IF p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 40 OR p_name ~ '[[:cntrl:]]'
       OR length(v_school) > 60 OR v_school ~ '[[:cntrl:]]' OR length(v_major) > 60 OR v_major ~ '[[:cntrl:]]'
       OR length(v_role) > 80 OR v_role ~ '[[:cntrl:]]'
       OR p_grade IS NOT NULL AND p_grade NOT IN ('1학년','2학년','3학년','4학년','5학년 이상','대학원','기타') THEN
        RAISE EXCEPTION 'invalid profile' USING ERRCODE = '22023';
    END IF;
    SELECT u.id INTO v_user FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unauthorized'); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('syncup.onboarding.user:' || v_user::text, 0));
    IF NOT EXISTS (SELECT 1 FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active) THEN
        RETURN jsonb_build_object('outcome','unauthorized');
    END IF;
    UPDATE syncup.users SET name=btrim(p_name) WHERE id=v_user;
    INSERT INTO syncup.onboarding_profiles(user_id,school,major,grade,role)
        VALUES (v_user,v_school,v_major,p_grade,v_role)
        ON CONFLICT (user_id) DO UPDATE SET school=excluded.school, major=excluded.major, grade=excluded.grade,
            role=excluded.role, updated_at=clock_timestamp();
    RETURN jsonb_build_object('outcome','saved');
END $$;
REVOKE ALL ON FUNCTION syncup.onboarding_profile_save(text,text,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.onboarding_profile_save(text,text,text,text,text,text) TO syncup_api;

-- Set the photo, or remove it when both p_type and p_photo are NULL. The type must match the leading bytes.
CREATE OR REPLACE FUNCTION syncup.onboarding_photo_set(p_digest text, p_type text, p_photo bytea)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid;
BEGIN
    IF (p_type IS NULL) <> (p_photo IS NULL)
       OR p_photo IS NOT NULL AND (
            length(p_photo) NOT BETWEEN 12 AND 300000
            OR NOT CASE p_type
                WHEN 'image/png' THEN substring(p_photo FROM 1 FOR 8) = decode('89504e470d0a1a0a', 'hex')
                WHEN 'image/jpeg' THEN substring(p_photo FROM 1 FOR 3) = decode('ffd8ff', 'hex')
                WHEN 'image/webp' THEN substring(p_photo FROM 1 FOR 4) = decode('52494646', 'hex')
                    AND substring(p_photo FROM 9 FOR 4) = decode('57454250', 'hex')
                ELSE false END) THEN
        RAISE EXCEPTION 'invalid photo' USING ERRCODE = '22023';
    END IF;
    SELECT u.id INTO v_user FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unauthorized'); END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('syncup.onboarding.user:' || v_user::text, 0));
    IF NOT EXISTS (SELECT 1 FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active) THEN
        RETURN jsonb_build_object('outcome','unauthorized');
    END IF;
    IF p_photo IS NULL THEN
        UPDATE syncup.onboarding_profiles SET photo=NULL, photo_type=NULL, updated_at=clock_timestamp() WHERE user_id=v_user;
    ELSE
        INSERT INTO syncup.onboarding_profiles(user_id,photo,photo_type) VALUES (v_user,p_photo,p_type)
            ON CONFLICT (user_id) DO UPDATE SET photo=excluded.photo, photo_type=excluded.photo_type,
                updated_at=clock_timestamp();
    END IF;
    RETURN jsonb_build_object('outcome','saved');
END $$;
REVOKE ALL ON FUNCTION syncup.onboarding_photo_set(text,text,bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.onboarding_photo_set(text,text,bytea) TO syncup_api;

-- Withdrawal (회원 탈퇴), no consent needed. The account row stays, inactive and renamed, because approved cards,
-- events and notes refer to it; everything that identifies or signs in the person goes: GitHub identity (the same
-- login later makes a new account), sessions, consents, profile and photo, collector keys, team memberships.
-- Teams where nobody else is an active member are deleted with all their records; in the other teams the cards the
-- person approved stay under the new name. p_confirm must equal the current name. All in one transaction, behind the
-- same locks as sign-in (GitHub account, then user) and the invite join (team).
CREATE OR REPLACE FUNCTION syncup.onboarding_withdraw(p_digest text, p_confirm text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_name text; v_lock bigint; v_team uuid; v_teams uuid[];
BEGIN
    IF p_confirm IS NULL THEN RAISE EXCEPTION 'invalid withdrawal' USING ERRCODE = '22023'; END IF;
    SELECT u.id INTO v_user FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unauthorized'); END IF;
    FOR v_lock IN SELECT DISTINCT hashtextextended('syncup.onboarding.github:' || i.subject, 0)
        FROM syncup.identities i WHERE i.user_id=v_user AND i.provider='github' ORDER BY 1 LOOP
        PERFORM pg_advisory_xact_lock(v_lock);
    END LOOP;
    PERFORM pg_advisory_xact_lock(hashtextextended('syncup.onboarding.user:' || v_user::text, 0));
    SELECT u.name INTO v_name FROM syncup.onboarding_sessions s JOIN syncup.users u ON u.id=s.user_id
        WHERE s.digest=p_digest AND s.expires_at > clock_timestamp() AND u.active;
    IF NOT FOUND THEN RETURN jsonb_build_object('outcome','unauthorized'); END IF;
    IF btrim(p_confirm) <> btrim(v_name) THEN RETURN jsonb_build_object('outcome','name_mismatch'); END IF;
    SELECT COALESCE(array_agg(m.team_id ORDER BY m.team_id), '{}') INTO v_teams
        FROM syncup.memberships m WHERE m.user_id=v_user;
    BEGIN
        FOREACH v_team IN ARRAY v_teams LOOP
            PERFORM pg_advisory_xact_lock(hashtextextended(v_team::text, 0));
        END LOOP;
        FOREACH v_team IN ARRAY v_teams LOOP
            IF EXISTS (SELECT 1 FROM syncup.memberships m JOIN syncup.users o ON o.id=m.user_id
                       WHERE m.team_id=v_team AND m.user_id <> v_user AND m.active AND o.active) THEN
                DELETE FROM syncup.memberships WHERE team_id=v_team AND user_id=v_user;
            ELSE
                DELETE FROM syncup.conflict_events WHERE team_id=v_team;
                DELETE FROM syncup.conflicts WHERE team_id=v_team;
                DELETE FROM syncup.conflict_checks WHERE team_id=v_team;
                DELETE FROM syncup.record_states WHERE team_id=v_team;
                DELETE FROM syncup.todo_states WHERE team_id=v_team;
                DELETE FROM syncup.shared_cards WHERE team_id=v_team;
                DELETE FROM syncup.team_settings WHERE team_id=v_team;
                DELETE FROM syncup.team_notion_links WHERE team_id=v_team;
                DELETE FROM syncup.team_repo_links WHERE team_id=v_team;
                DELETE FROM syncup.invite_events WHERE invite_id IN (SELECT id FROM syncup.invites WHERE team_id=v_team);
                DELETE FROM syncup.invites WHERE team_id=v_team;
                DELETE FROM syncup.onboarding_teams WHERE team_id=v_team;
                DELETE FROM syncup.memberships WHERE team_id=v_team;
                DELETE FROM syncup.teams WHERE id=v_team;
            END IF;
        END LOOP;
        DELETE FROM syncup.tokens WHERE user_id=v_user;
        DELETE FROM syncup.onboarding_teams WHERE user_id=v_user;
        DELETE FROM syncup.onboarding_profiles WHERE user_id=v_user;
        DELETE FROM syncup.onboarding_consents WHERE user_id=v_user;
        DELETE FROM syncup.onboarding_sessions WHERE user_id=v_user;
        DELETE FROM syncup.identities WHERE user_id=v_user;
        UPDATE syncup.users SET active=false, name='탈퇴한 팀원' WHERE id=v_user;
    EXCEPTION WHEN foreign_key_violation THEN
        RETURN jsonb_build_object('outcome','blocked');
    END;
    RETURN jsonb_build_object('outcome','deleted','deleted',true);
END $$;
REVOKE ALL ON FUNCTION syncup.onboarding_withdraw(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.onboarding_withdraw(text,text) TO syncup_api;
