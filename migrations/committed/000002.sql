--! Previous: sha1:c062adf1ef2cbc085e4e7003c543afe6895af7f6
--! Hash: sha1:6356e6c8bdc7c99a4a43481d6c48503b3e369248

--! split: 1-current.sql
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

--! split: 2-reset-password-null-token.sql
-- Rejects a password reset when no reset is pending, or when the pending token
-- is older than v_token_max_duration.
--
-- `user_secrets.reset_password_token` is NULL for every user without a pending
-- reset. A comparison with NULL yields NULL, and an `if` treats NULL as false,
-- so a reject branch guarded by a plain inequality is skipped. The check
-- therefore rejects NULL explicitly, and the success path needs a positive match.
--
-- request_password_reset only replaces a token once it is older than the
-- window, so without the age check a token would stay valid until it is used.
create or replace function app_private.reset_password(
  user_id uuid,
  reset_token text,
  new_password text
) returns boolean as $$
declare
  v_user app_public.users;
  v_user_secret app_private.user_secrets;
  v_token_max_duration interval = interval '3 days';
begin
  select users.* into v_user
  from app_public.users
  where id = reset_password.user_id;

  if v_user is null then return null; end if;

  -- Load their secrets
  select * into v_user_secret from app_private.user_secrets
  where user_secrets.user_id = v_user.id;

  -- Have there been too many reset attempts?
  if (
    v_user_secret.first_failed_reset_password_attempt is not null
    and v_user_secret.first_failed_reset_password_attempt > NOW() - v_token_max_duration
    and v_user_secret.failed_reset_password_attempts >= 20
  ) then
    raise exception 'Password reset locked - too many reset attempts' using errcode = 'LOCKD';
  end if;

  -- Not too many reset attempts, let's check the token
  if v_user_secret.reset_password_token is null
    or v_user_secret.reset_password_token is distinct from reset_token
    or v_user_secret.reset_password_token_generated is null
    or v_user_secret.reset_password_token_generated < now() - v_token_max_duration then
    -- Wrong or expired token, bump all the attempt tracking figures
    update app_private.user_secrets
    set
      failed_reset_password_attempts = (case when first_failed_reset_password_attempt is null or first_failed_reset_password_attempt < now() - v_token_max_duration then 1 else failed_reset_password_attempts + 1 end),
      first_failed_reset_password_attempt = (case when first_failed_reset_password_attempt is null or first_failed_reset_password_attempt < now() - v_token_max_duration then now() else first_failed_reset_password_attempt end)
    where user_secrets.user_id = v_user.id;
    return null;
  end if;

  -- Excellent - they're legit
  perform app_private.assert_valid_password(new_password);

  -- Let's reset the password as requested
  update app_private.user_secrets
  set
    password_hash = crypt(new_password, gen_salt('bf')),
    failed_password_attempts = 0,
    first_failed_password_attempt = null,
    reset_password_token = null,
    reset_password_token_generated = null,
    failed_reset_password_attempts = 0,
    first_failed_reset_password_attempt = null
  where user_secrets.user_id = v_user.id;

  -- Revoke the users' sessions
  delete from app_private.sessions
  where sessions.user_id = v_user.id;

  -- Notify user their password was reset
  perform graphile_worker.add_job(
    'user__audit',
    json_build_object(
      'type', 'reset_password',
      'user_id', v_user.id,
      'current_user_id', app_public.current_user_id()
    ));
  return true;
end;
$$ language plpgsql strict volatile;

--! split: 3-playground-commit-chain.sql
-- A playground's newest commit was found with `order by created_at desc limit 1`,
-- and `created_at` defaults to `now()`, which is the transaction's start time.
-- Saving a playground owned by someone else forks it and commits onto the fork
-- in one request transaction, so both commits carry the same timestamp and
-- "newest" is settled arbitrarily: opening such a fork can load the copy of the
-- source instead of the work that was saved, and the next save on it can take
-- the copy as its parent and branch the history.
--
-- A playground now names its newest commit. The chain is recorded, by the
-- playground's head and each commit's parent, rather than inferred from a clock.
alter table app_public.playgrounds
  add column if not exists head_commit_id text
    references app_public.playground_commits on delete set null;

-- Existing rows have no head recorded. A commit that nothing names as a parent
-- is the tip of its chain, so prefer one of those; that also repairs a fork
-- whose two commits share a timestamp, because only the save is a tip.
update app_public.playgrounds p
set head_commit_id = (
  select c.id
  from app_public.playground_commits c
  where c.playground_hash = p.hash
  order by
    exists (
      select 1 from app_public.playground_commits child where child.parent_id = c.id
    ) asc,
    c.created_at desc
  limit 1
)
where p.head_commit_id is null;

create or replace function app_public.create_playground_commit(
  p_playground_name text,
  p_commit_message text,
  p_commit_data jsonb,
  p_playground_hash text default null,
  p_playground_description text default null
) returns app_public.playground_commit_result as $$
declare
  v_playground_hash text;
  v_parent_id text;
  v_commit app_public.playground_commits;
  v_result app_public.playground_commit_result;
  v_user_id uuid;
  v_data_size bigint;
  v_previous_size bigint := 0;
  v_expires_at timestamptz;
begin
  v_user_id := app_public.current_user_id();

  v_data_size := length(p_commit_data::text);

  -- Enforce storage limit for authenticated users
  if v_user_id is not null then
    declare
      v_total_size bigint;
      v_max_size bigint;
    begin
      select coalesce(sum(p.data_size), 0) into v_total_size
      from app_public.playgrounds p
      where p.user_id = v_user_id;

      -- A commit replaces the playground's stored size rather than adding to
      -- it, so the sum has to drop what that row already counts.
      if p_playground_hash is not null then
        select coalesce(p.data_size, 0) into v_previous_size
        from app_public.playgrounds p
        where p.hash = p_playground_hash;
      end if;

      select app_public.max_storage_bytes(u.role) into v_max_size
      from app_public.users u
      where u.id = v_user_id;

      if v_total_size - coalesce(v_previous_size, 0) + v_data_size > v_max_size then
        raise exception 'Storage limit exceeded' using errcode = 'DNIED';
      end if;
    end;
  end if;

  -- Calculate expiration for anonymous playgrounds
  if v_user_id is null then
    v_expires_at := now() + app_public.calculate_retention(v_data_size);
  end if;

  if p_playground_hash is null then
    v_playground_hash := substring(
      encode(digest(p_commit_data::text || now()::text, 'sha256'), 'hex'),
      1, 12
    );

    insert into app_public.playgrounds (
      hash,
      name,
      description,
      privacy,
      user_id,
      data_size,
      expires_at
    ) values (
      v_playground_hash,
      case when v_user_id is not null then p_playground_name else null end,
      p_playground_description,
      'secret'::app_public.privacy,
      v_user_id,
      v_data_size,
      v_expires_at
    );
  else
    -- Verify playground exists and user owns it (or is admin)
    select p.hash, p.head_commit_id into v_playground_hash, v_parent_id
    from app_public.playgrounds p
    where p.hash = p_playground_hash
      and (
        p.user_id = v_user_id
        or v_user_id in (
          select id from app_public.users where role = 'admin'
        )
      );

    if v_playground_hash is null then
      raise exception 'Playground not found or access denied' using errcode = 'DNIED';
    end if;
  end if;

  insert into app_public.playground_commits (playground_hash, parent_id, message, data)
  values (v_playground_hash, v_parent_id, p_commit_message, p_commit_data)
  returning * into v_commit;

  -- The commit just made is the playground's newest, and the size the limit
  -- above was tested against is the size it now stores.
  update app_public.playgrounds
  set head_commit_id = v_commit.id,
      data_size = v_data_size
  where hash = v_playground_hash;

  v_result.commit_id := v_commit.id;
  v_result.playground_hash := v_commit.playground_hash;
  v_result.parent_id := v_commit.parent_id;
  v_result.message := v_commit.message;
  v_result.created_at := v_commit.created_at;

  return v_result;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

------------------------------------------------------------------------------------------------------------------------


-- fork_playground had three defects, and never recorded the head of the
-- playground it created:
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
