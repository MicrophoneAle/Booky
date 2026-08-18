-- DEPLOY (existing production only): This migration describes a table that
-- already exists in production. Do NOT execute it against the live database -
-- CREATE TABLE would fail on the live table with data in it. Mark it applied:
--   supabase migration repair --status applied 20260520000000
-- Only 20260611120000_drop_parsed_cache_columns.sql should actually run on
-- production. Fresh empty databases replay the full chain in timestamp order.
--
-- Baseline: public.documents as recorded from production (2026-08-18).
-- Replays the table shape that previously existed only in the Supabase dashboard.
--
-- Storage buckets in production (not created or altered here):
--   pdfs (private), book-assets (public)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE public.documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  storage_path text NOT NULL,
  created_at timestamp without time zone DEFAULT now(),
  total_pages integer,
  chapters jsonb,
  content jsonb,
  word_count integer NOT NULL DEFAULT 0,
  user_id text NOT NULL,
  parser_version integer DEFAULT 0,
  parse_status text DEFAULT 'ready',
  parsed_cache text,
  parsed_cache_version integer,
  parse_progress jsonb,
  CONSTRAINT documents_pkey PRIMARY KEY (id)
);

CREATE INDEX documents_user_id_idx ON public.documents USING btree (user_id);

ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
-- RLS enabled with zero policies (deny-all for anon/authenticated roles;
-- the API bypasses via the service-role key). Do not add policies here.
