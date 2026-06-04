alter table documents
add column if not exists parsed_cache text;

alter table documents
add column if not exists parsed_cache_version integer;
