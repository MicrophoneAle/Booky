-- M10: Drop dead parsed_cache columns (always written null, 0 rows non-null in
-- production). Server no longer reads parsed_cache as a fallback.
-- Converge user_id to NOT NULL (0 null rows in production today).

ALTER TABLE public.documents
  DROP COLUMN IF EXISTS parsed_cache,
  DROP COLUMN IF EXISTS parsed_cache_version;

ALTER TABLE public.documents
  ALTER COLUMN user_id SET NOT NULL;
