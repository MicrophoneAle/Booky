alter table documents
add column if not exists parse_status text default 'ready';
