--! Previous: sha1:1ec3553d6796930962ca00335f81f516509b90a8
--! Hash: sha1:9ef12768932f0d3d594fbbdcdf7385035fcdcfe2

--! split: 1-current.sql
-- One statement of the private-playground entitlement, and three callers.
--
-- The rule - a private playground needs a sponsor, pro or admin account - was
-- written out three times, in three forms that could disagree: the trigger that
-- refuses a bad write, the insert_authenticated policy that restates the same
-- condition as a with-check, and fork_playground, which needs the rule as a
-- choice rather than a check. This function is the rule. Each caller decides
-- only what to do with the answer.
--
-- Security definer, like app_public.current_user_id and the trigger that calls
-- it: the answer must not depend on who asks. app_public.users is readable by
-- everyone (its select policy is `true`), so this exposes nothing a caller
-- could not already read for itself.
--
-- A null user id answers false. Anonymity is not an entitlement failure
-- though, so the trigger keeps its own message for it.
create or replace function app_public.may_have_private(v_user_id uuid)
returns boolean as $$
  select exists (
    select 1 from app_public.users
    where id = v_user_id and role in ('sponsor', 'pro', 'admin')
  );
$$ language sql stable security definer set search_path to pg_catalog, public, pg_temp;

comment on function app_public.may_have_private(uuid) is
  'Whether this account may own a private playground. The one statement of that rule.';

grant execute on function app_public.may_have_private(uuid) to :DATABASE_VISITOR;

-- The choke point. Every write into app_public.playgrounds goes through a
-- security definer function owned by the table owner, and the table is not
-- force row level security, so RLS is bypassed on those paths and this trigger
-- is the only check that cannot be routed around.
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

  if not app_public.may_have_private(NEW.user_id) then
    raise exception 'Private playgrounds require a sponsor account'
      using errcode = 'DNIED';
  end if;

  return NEW;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

-- The policy's copy of the rule is unreachable today, for the reason above. It
-- stays as the last line for a write path that does not go through a definer
-- function, and now says the same thing as the trigger by construction.
drop policy if exists insert_authenticated on app_public.playgrounds;
create policy insert_authenticated on app_public.playgrounds
  for insert with check (
    user_id = app_public.current_user_id()
    and user_id is not null
    and (privacy <> 'private' or app_public.may_have_private(user_id))
  );

-- A fork reads the entitlement as a choice: the most private level the forking
-- user may have, rather than a refusal for a free account.
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
  v_privacy := case
    when app_public.may_have_private(v_user_id) then 'private'
    else 'secret'
  end;

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

  update app_public.playgrounds
  set head_commit_id = v_latest_commit.id
  where hash = v_new_hash;

  v_result.commit_id := v_latest_commit.id;
  v_result.playground_hash := v_new_hash;
  v_result.parent_id := null;
  v_result.message := v_latest_commit.message;
  v_result.created_at := v_latest_commit.created_at;

  return v_result;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;
