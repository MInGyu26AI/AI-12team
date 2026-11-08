-- Latest attempt only; existing team RLS and immutable approved records are preserved.
ALTER TABLE syncup.conflict_checks ADD COLUMN IF NOT EXISTS diagnostics jsonb
    NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(diagnostics) = 'object');
