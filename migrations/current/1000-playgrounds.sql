create type app_public.privacy as enum(
  'private',
  'secret',
  'public'
);

------------------------------------------------------------------------------------------------------------------------

create table app_public.playgrounds (
  hash text primary key,
  user_id uuid
    references app_public.users on delete cascade,
  fork_hash text
    references app_public.playgrounds,
  privacy app_public.privacy not null default 'secret',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text check (name is null or name ~ '^[a-zA-Z0-9_-]+$'),
  description text,
  data_size bigint not null default 0,
  expires_at timestamptz
);

create index on app_public.playgrounds (user_id);
create index on app_public.playgrounds (fork_hash);
create index on app_public.playgrounds (created_at desc);
create index on app_public.playgrounds (expires_at) where user_id is null and expires_at is not null;

------------------------------------------------------------------------------------------------------------------------

alter table app_public.playgrounds enable row level security;

-- Drop old policies if they exist
drop policy if exists select_own_and_public on app_public.playgrounds;
drop policy if exists insert_own on app_public.playgrounds;
drop policy if exists update_own on app_public.playgrounds;
drop policy if exists delete_own on app_public.playgrounds;
drop policy if exists manage_all_as_admin on app_public.playgrounds;

-- Select: public/secret playgrounds OR owned playgrounds OR admin
create policy select_public_secret_or_own on app_public.playgrounds
  for select using (
    privacy in ('public', 'secret')
    or user_id = app_public.current_user_id()
    or exists (
      select 1 from app_public.users
      where id = app_public.current_user_id() and role = 'admin'
    )
  );

-- Insert: authenticated users (will create owned playgrounds)
-- Private playgrounds require sponsor/pro/admin role
create policy insert_authenticated on app_public.playgrounds
  for insert with check (
    user_id = app_public.current_user_id()
    and user_id is not null
    and (privacy <> 'private' or exists (
      select 1 from app_public.users
      where id = app_public.current_user_id() and role in ('sponsor', 'pro', 'admin')
    ))
  );

-- Insert: anonymous users (public/secret only, no custom names)
create policy insert_anonymous on app_public.playgrounds
  for insert with check (
    user_id is null
    and privacy in ('public', 'secret')
    and name is null
  );

-- Update: only owned playgrounds OR admin
create policy update_own_or_admin on app_public.playgrounds
  for update using (
    user_id is not null and (
      user_id = app_public.current_user_id()
      or exists (
        select 1 from app_public.users
        where id = app_public.current_user_id() and role = 'admin'
      )
    )
  );

-- Delete: only owned playgrounds OR admin
create policy delete_own_or_admin on app_public.playgrounds
  for delete using (
    user_id is not null and (
      user_id = app_public.current_user_id()
      or exists (
        select 1 from app_public.users
        where id = app_public.current_user_id() and role = 'admin'
      )
    )
  );

grant
  select,
  insert (name, description, privacy, fork_hash),
  update (name, description, privacy),
  delete
  on app_public.playgrounds to :DATABASE_VISITOR;

create trigger _100_timestamps
  before insert or update
  on app_public.playgrounds
  for each row
  execute procedure app_private.tg__timestamps();

------------------------------------------------------------------------------------------------------------------------

create table app_public.playground_stars (
  playground_hash text not null references app_public.playgrounds on delete cascade,
  user_id uuid not null default app_public.current_user_id() references app_public.users on delete cascade,
  created_at timestamptz not null default now(),
  primary key (playground_hash, user_id)
);

create index on app_public.playground_stars (user_id);

alter table app_public.playground_stars enable row level security;

create policy select_all on app_public.playground_stars
  for select using (true);
create policy insert_own on app_public.playground_stars
  for insert with check (user_id = app_public.current_user_id());
create policy delete_own on app_public.playground_stars
  for delete using (user_id = app_public.current_user_id());

grant
  select,
  insert (playground_hash),
  delete
  on app_public.playground_stars to :DATABASE_VISITOR;

------------------------------------------------------------------------------------------------------------------------

create table app_public.playground_comments (
  id int primary key generated always as identity (start 1000),
  user_id uuid not null default app_public.current_user_id() references app_public.users on delete cascade,
  playground_hash text not null references app_public.playgrounds on delete cascade,
  body text not null,
  range json,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table app_public.playground_comments enable row level security;

create policy select_all on app_public.playground_comments
  for select using (true);
create policy insert_own on app_public.playground_comments
  for insert with check (user_id = app_public.current_user_id());
create policy update_own on app_public.playground_comments
  for update using (user_id = app_public.current_user_id());
create policy delete_own on app_public.playground_comments
  for delete using (user_id = app_public.current_user_id());

grant
  select,
  insert (body, range, playground_hash),
  update (body),
  delete
  on app_public.playground_comments to :DATABASE_VISITOR;

create trigger _100_timestamps
  before insert or update
  on app_public.playground_comments
  for each row
  execute procedure app_private.tg__timestamps();

------------------------------------------------------------------------------------------------------------------------

/*
 * Maximum storage in bytes per user role.
 */
create function app_public.max_storage_bytes(p_role app_public.user_role)
returns bigint as $$
  select case p_role
    when 'admin'   then 1073741824  -- 1 GB
    when 'pro'     then 536870912   -- 512 MB
    when 'sponsor' then 536870912   -- 512 MB
    when 'user'    then 52428800    -- 50 MB
  end;
$$ language sql immutable;
