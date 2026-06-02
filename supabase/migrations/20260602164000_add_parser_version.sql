alter table documents
add column if not exists parser_version integer default 0;
