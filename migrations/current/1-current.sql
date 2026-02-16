--! split: 2000-content-scanning.sql

create type app_public.content_scan_severity as enum (
  'low',
  'medium',
  'high',
  'critical'
);

create type app_public.content_scan_category as enum (
  'pii',
  'spam',
  'illegal',
  'copyright'
);

create type app_public.content_flag_status as enum (
  'pending',
  'dismissed',
  'confirmed'
);

------------------------------------------------------------------------------------------------------------------------

create table app_private.content_scan_rules (
  id bigserial primary key,
  name text not null,
  pattern text not null,
  severity app_public.content_scan_severity not null,
  category app_public.content_scan_category not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on app_private.content_scan_rules (enabled);
create index on app_private.content_scan_rules (severity);
create index on app_private.content_scan_rules (category);

create trigger _100_timestamps
  before insert or update
  on app_private.content_scan_rules
  for each row
  execute procedure app_private.tg__timestamps();

------------------------------------------------------------------------------------------------------------------------

create table app_public.content_flags (
  id bigserial primary key,
  playground_hash text not null
    references app_public.playgrounds on delete cascade,
  commit_id text
    references app_public.playground_commits on delete set null,
  rule_id bigint
    references app_private.content_scan_rules on delete set null,
  matched_text text not null,
  file_path text not null,
  line_number integer not null,
  severity app_public.content_scan_severity not null,
  category app_public.content_scan_category not null,
  status app_public.content_flag_status not null default 'pending',
  created_at timestamptz not null default now()
);

create index on app_public.content_flags (playground_hash);
create index on app_public.content_flags (commit_id);
create index on app_public.content_flags (status);
create index on app_public.content_flags (severity);
create index on app_public.content_flags (created_at desc);

alter table app_public.content_flags enable row level security;

create policy manage_all_as_admin on app_public.content_flags
  for all using (exists (
    select 1 from app_public.users
    where id = app_public.current_user_id() and role = 'admin'
  ));

grant
  select,
  insert,
  update,
  delete
  on app_public.content_flags to :DATABASE_VISITOR;

------------------------------------------------------------------------------------------------------------------------

create table app_public.playground_reports (
  id bigserial primary key,
  playground_hash text not null
    references app_public.playgrounds on delete cascade,
  commit_id text
    references app_public.playground_commits on delete set null,
  reporter_id uuid
    references app_public.users on delete set null,
  reason text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index on app_public.playground_reports (playground_hash);
create index on app_public.playground_reports (commit_id);
create index on app_public.playground_reports (reporter_id);
create index on app_public.playground_reports (created_at desc);

alter table app_public.playground_reports enable row level security;

create policy insert_own_report on app_public.playground_reports
  for insert with check (
    reporter_id = app_public.current_user_id()
  );

create policy manage_all_as_admin on app_public.playground_reports
  for all using (exists (
    select 1 from app_public.users
    where id = app_public.current_user_id() and role = 'admin'
  ));

grant
  select,
  insert,
  update,
  delete
  on app_public.playground_reports to :DATABASE_VISITOR;

------------------------------------------------------------------------------------------------------------------------

insert into app_private.content_scan_rules (name, pattern, severity, category)
values
  (
    'SSN pattern',
    '\\b\\d{3}-\\d{2}-\\d{4}\\b',
    'high',
    'pii'
  ),
  (
    'Credit card number',
    '(?:\\d[ -]*?){13,19}',
    'critical',
    'pii'
  ),
  (
    'Bulk email list',
    '(?:[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,})(?:[\\s,;]+[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}){9,}',
    'medium',
    'spam'
  ),
  (
    'Common profanity',
    '\\b(?:fuck|shit|bitch|asshole|cunt|bastard|dick|pussy)\\b',
    'medium',
    'illegal'
  ),
  (
    'SQL injection payloads',
    '(?:''|\\")\\s*or\\s*1\\s*=\\s*1|union\\s+select|;\\s*drop\\s+table|--\\s',
    'high',
    'illegal'
  ),
  (
    'Suspicious SQL execution',
    '\\bcopy\\s+\\(.*\\)\\s+to\\s+program\\b|\\bpg_sleep\\s*\\(|\\bcreate\\s+extension\\s+plpythonu\\b',
    'critical',
    'illegal'
  );
