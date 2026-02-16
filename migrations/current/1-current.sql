create type app_public.playground_report_reason as enum(
  'illegal_content',
  'pii_exposure',
  'spam',
  'harassment',
  'copyright',
  'other'
);

create type app_public.playground_report_status as enum(
  'pending',
  'reviewed',
  'dismissed',
  'actioned'
);

create table app_public.playground_reports (
  id uuid primary key default gen_random_uuid(),
  playground_hash text not null references app_public.playgrounds on delete cascade,
  reporter_id uuid not null default app_public.current_user_id() references app_public.users on delete cascade,
  reason app_public.playground_report_reason not null,
  details text check (details is null or length(details) <= 1000),
  status app_public.playground_report_status not null default 'pending',
  reviewed_by uuid references app_public.users on delete set null,
  resolution_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint playground_reports_unique_reporter unique (playground_hash, reporter_id)
);

create index on app_public.playground_reports (status, created_at);

alter table app_public.playground_reports enable row level security;

create policy select_own on app_public.playground_reports
  for select using (reporter_id = app_public.current_user_id());

create policy insert_own on app_public.playground_reports
  for insert with check (reporter_id = app_public.current_user_id());

create policy select_all_as_admin on app_public.playground_reports
  for select using (exists (
    select 1 from app_public.users
    where id = app_public.current_user_id() and role = 'admin'
  ));

create policy update_all_as_admin on app_public.playground_reports
  for update using (exists (
    select 1 from app_public.users
    where id = app_public.current_user_id() and role = 'admin'
  )) with check (exists (
    select 1 from app_public.users
    where id = app_public.current_user_id() and role = 'admin'
  ));

grant
  select,
  insert (playground_hash, reason, details),
  update (status, reviewed_by, resolution_notes)
  on app_public.playground_reports to :DATABASE_VISITOR;

create trigger _100_timestamps
  before insert or update
  on app_public.playground_reports
  for each row
  execute procedure app_private.tg__timestamps();
