-- Metadata-only quota ledger. Apply as the web-key functions' BYPASSRLS owner.
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'AI quota migration requires a BYPASSRLS owner';
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS syncup.ai_calls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES syncup.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_calls_time ON syncup.ai_calls(created_at);
CREATE INDEX IF NOT EXISTS ai_calls_user_time ON syncup.ai_calls(user_id,created_at);
ALTER TABLE syncup.ai_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE syncup.ai_calls FORCE ROW LEVEL SECURITY;
REVOKE ALL ON syncup.ai_calls FROM PUBLIC, syncup_api;
REVOKE ALL ON SEQUENCE syncup.ai_calls_id_seq FROM PUBLIC, syncup_api;

CREATE OR REPLACE FUNCTION syncup.reserve_ai_call(
  digest text, target uuid, user_min integer, user_day integer, total_min integer, total_day integer
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE actor uuid; day_start timestamptz; minute_start timestamptz;
BEGIN
  actor := syncup.authenticate(digest);
  IF actor IS NULL OR NOT EXISTS (
    SELECT 1 FROM syncup.memberships WHERE user_id=actor AND team_id=target AND active
  ) THEN RAISE insufficient_privilege; END IF;
  IF user_min IS NULL OR user_day IS NULL OR total_min IS NULL OR total_day IS NULL
     OR user_min NOT BETWEEN 1 AND 60 OR user_day NOT BETWEEN 1 AND 1000
     OR total_min NOT BETWEEN 1 AND 300 OR total_day NOT BETWEEN 1 AND 10000 THEN
    RAISE EXCEPTION 'Invalid AI quota';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('syncup-ai-quota-v1',0));
  day_start := date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  minute_start := now() - interval '1 minute';
  DELETE FROM syncup.ai_calls WHERE created_at < day_start - interval '2 days';
  IF (SELECT count(*) FROM syncup.ai_calls WHERE created_at >= day_start) >= total_day
     OR (SELECT count(*) FROM syncup.ai_calls WHERE created_at >= minute_start) >= total_min
     OR (SELECT count(*) FROM syncup.ai_calls WHERE user_id=actor AND created_at >= day_start) >= user_day
     OR (SELECT count(*) FROM syncup.ai_calls WHERE user_id=actor AND created_at >= minute_start) >= user_min THEN
    RETURN false;
  END IF;
  INSERT INTO syncup.ai_calls(user_id) VALUES(actor);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION syncup.reserve_ai_call(text,uuid,integer,integer,integer,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION syncup.reserve_ai_call(text,uuid,integer,integer,integer,integer) TO syncup_api;
