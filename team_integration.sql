-- Additive migration: approved shared_cards remain immutable and unchanged.
ALTER TABLE syncup.shared_cards ALTER COLUMN received_at SET DEFAULT clock_timestamp();
CREATE TABLE syncup.record_states (
    team_id uuid NOT NULL, card_id text NOT NULL,
    state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','review','superseded','rejected')),
    PRIMARY KEY(team_id,card_id),
    FOREIGN KEY(team_id,card_id) REFERENCES syncup.shared_cards(team_id,id)
);
CREATE TABLE syncup.conflict_checks (
    team_id uuid NOT NULL, card_id text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','complete','failed')),
    attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(),
    detail text NOT NULL DEFAULT '',
    PRIMARY KEY(team_id,card_id),
    FOREIGN KEY(team_id,card_id) REFERENCES syncup.shared_cards(team_id,id)
);
CREATE TABLE syncup.conflicts (
    team_id uuid NOT NULL, id text NOT NULL, card_a text NOT NULL, card_b text NOT NULL,
    payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
    resolution text CHECK(resolution IN ('keep-existing','adopt-new','both-valid','discuss','obsolete')),
    note text NOT NULL DEFAULT '',
    PRIMARY KEY(team_id,id), UNIQUE(team_id,card_a,card_b), CHECK(card_a <> card_b),
    FOREIGN KEY(team_id,card_a) REFERENCES syncup.shared_cards(team_id,id),
    FOREIGN KEY(team_id,card_b) REFERENCES syncup.shared_cards(team_id,id)
);
CREATE TABLE syncup.conflict_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    team_id uuid NOT NULL, conflict_id text NOT NULL, actor uuid NOT NULL REFERENCES syncup.users(id),
    resolution text NOT NULL, note text NOT NULL, at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY(team_id,conflict_id) REFERENCES syncup.conflicts(team_id,id)
);
CREATE TABLE syncup.todo_states (
    team_id uuid NOT NULL, card_id text NOT NULL, done boolean NOT NULL,
    actor uuid NOT NULL REFERENCES syncup.users(id), at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(team_id,card_id),
    FOREIGN KEY(team_id,card_id) REFERENCES syncup.shared_cards(team_id,id)
);

DO $$ DECLARE name text; BEGIN
    FOREACH name IN ARRAY ARRAY['record_states','conflict_checks','conflicts','conflict_events','todo_states'] LOOP
        EXECUTE format('ALTER TABLE syncup.%I ENABLE ROW LEVEL SECURITY',name);
        EXECUTE format('ALTER TABLE syncup.%I FORCE ROW LEVEL SECURITY',name);
        EXECUTE format('GRANT SELECT,INSERT ON syncup.%I TO syncup_api',name);
        EXECUTE format('CREATE POLICY team_access ON syncup.%I TO syncup_api
          USING (team_id = nullif(current_setting(''syncup.team_id'',true),'''')::uuid
            AND EXISTS(SELECT 1 FROM syncup.memberships m WHERE m.team_id=%I.team_id))
          WITH CHECK (team_id = nullif(current_setting(''syncup.team_id'',true),'''')::uuid
            AND EXISTS(SELECT 1 FROM syncup.memberships m WHERE m.team_id=%I.team_id))',name,name,name);
    END LOOP;
END $$;
GRANT UPDATE ON syncup.record_states,syncup.conflict_checks,syncup.conflicts,syncup.todo_states TO syncup_api;
GRANT USAGE ON SEQUENCE syncup.conflict_events_id_seq TO syncup_api;
CREATE POLICY event_actor ON syncup.conflict_events AS RESTRICTIVE FOR INSERT TO syncup_api
    WITH CHECK(actor=nullif(current_setting('syncup.user_id',true),'')::uuid);
CREATE POLICY todo_actor_insert ON syncup.todo_states AS RESTRICTIVE FOR INSERT TO syncup_api
    WITH CHECK(actor=nullif(current_setting('syncup.user_id',true),'')::uuid);
CREATE POLICY todo_actor_update ON syncup.todo_states AS RESTRICTIVE FOR UPDATE TO syncup_api
    USING(true) WITH CHECK(actor=nullif(current_setting('syncup.user_id',true),'')::uuid);
-- Event rows and approved shared_cards cannot be updated or deleted by the API role.
