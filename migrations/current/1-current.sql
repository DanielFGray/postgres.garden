-- Private playgrounds are a paid entitlement (sponsor/pro/admin).
--
-- The rule could not live in RLS. Every write path into app_public.playgrounds
-- goes through a SECURITY DEFINER function owned by the table owner, and the
-- table is not FORCE ROW LEVEL SECURITY, so RLS is bypassed inside those
-- functions and the insert_authenticated policy's entitlement check is
-- unreachable. A trigger fires on every path regardless of RLS or definer
-- rights, so it is the only choke point that cannot be routed around.
create or replace function app_private.tg__playgrounds__privacy_entitlement()
returns trigger as $$
begin
  if NEW.privacy <> 'private' then
    return NEW;
  end if;

  if NEW.user_id is null then
    raise exception 'Anonymous playgrounds cannot be private'
      using errcode = 'DNIED';
  end if;

  if not exists (
    select 1 from app_public.users
    where id = NEW.user_id and role in ('sponsor', 'pro', 'admin')
  ) then
    raise exception 'Private playgrounds require a sponsor account'
      using errcode = 'DNIED';
  end if;

  return NEW;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

drop trigger if exists _200_privacy_entitlement on app_public.playgrounds;
create trigger _200_privacy_entitlement
  before insert or update of privacy, user_id on app_public.playgrounds
  for each row
  execute procedure app_private.tg__playgrounds__privacy_entitlement();

------------------------------------------------------------------------------------------------------------------------

-- fork_playground had three defects:
--   1. v_source was declared but never populated, so data_size was always null
--      and every fork failed the table's not-null constraint.
--   2. It hardcoded privacy => 'private', which combined with the RLS bypass
--      above handed any free account a private playground.
--   3. Being SECURITY DEFINER it reads the source with RLS bypassed, so it never
--      checked that the caller may see the playground it is copying.
create or replace function app_public.fork_playground(
  p_source_hash text,
  p_new_name text default null
) returns app_public.playground_commit_result as $$
declare
  v_source app_public.playgrounds;
  v_latest_commit app_public.playground_commits;
  v_new_hash text;
  v_result app_public.playground_commit_result;
  v_user_id uuid;
  v_privacy app_public.privacy;
begin
  v_user_id := app_public.current_user_id();

  if v_user_id is null then
    raise exception 'Must be logged in to fork a playground' using errcode = 'LOGIN';
  end if;

  select * into v_source
  from app_public.playgrounds
  where hash = p_source_hash;

  if v_source is null then
    raise exception 'Playground not found' using errcode = 'NTFND';
  end if;

  -- This function runs with RLS bypassed, so the read policy on playgrounds
  -- does not apply. Re-state it here or a caller could copy the contents of any
  -- playground whose hash they can name.
  if not (
    v_source.privacy in ('public', 'secret')
    or v_source.user_id = v_user_id
    or exists (
      select 1 from app_public.users
      where id = v_user_id and role = 'admin'
    )
  ) then
    raise exception 'Playground not found' using errcode = 'NTFND';
  end if;

  select * into v_latest_commit
  from app_public.playground_commits
  where playground_hash = p_source_hash
  order by created_at desc
  limit 1;

  if v_latest_commit is null then
    raise exception 'Source playground has no commits' using errcode = 'NTFND';
  end if;

  v_new_hash := substring(
    encode(digest(v_latest_commit.data::text || now()::text || v_user_id::text, 'sha256'), 'hex'),
    1, 12
  );

  -- A fork should not be broadcast, so take the most private level the forking
  -- user is entitled to rather than failing outright for free accounts.
  select case when u.role in ('sponsor', 'pro', 'admin') then 'private' else 'secret' end
  into v_privacy
  from app_public.users u
  where u.id = v_user_id;

  insert into app_public.playgrounds (hash, name, description, privacy, user_id, fork_hash, data_size)
  values (
    v_new_hash,
    coalesce(p_new_name, 'fork-of-' || substring(p_source_hash, 1, 8)),
    'Forked from ' || coalesce(v_source.name, p_source_hash),
    v_privacy,
    v_user_id,
    p_source_hash,
    v_source.data_size
  );

  insert into app_public.playground_commits (playground_hash, parent_id, message, data)
  values (
    v_new_hash,
    null,  -- No parent (fresh fork)
    'Initial commit (forked from ' || p_source_hash || ')',
    v_latest_commit.data
  )
  returning * into v_latest_commit;

  v_result.commit_id := v_latest_commit.id;
  v_result.playground_hash := v_new_hash;
  v_result.parent_id := null;
  v_result.message := v_latest_commit.message;
  v_result.created_at := v_latest_commit.created_at;

  return v_result;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;
