alter table documents
add column if not exists parse_progress jsonb;
