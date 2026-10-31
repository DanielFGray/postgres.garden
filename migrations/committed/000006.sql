--! Previous: sha1:138b54e512d3e460fc9f554950e20fe006f048a7
--! Hash: sha1:ef2f837979b25b35c0c3112d7bd123245f03f622

--! split: 1-current.sql
-- A save with no account is bounded, like every other save.

-- Storage is capped per account by role. A writer with no account has no role,
-- and what a key holds is one playground, so the cap is what that playground
-- may store: 1MB, some 130 times the 8KB a share link used to fit.
--
-- 1MB is an interim number, not a storage boundary: a value this size is held
-- out of line in TOAST either way, since that starts at about 2KB. It bounds a
-- save until commits move to blob storage, where the question is answered by
-- where the bytes live rather than by a limit on how many there may be.
--
-- It caps one save. Nothing caps how many playgrounds a visitor may start,
-- which is a rate limit, and there is none.
create or replace function app_public.max_storage_bytes(
  p_role app_public.user_role default null
) returns bigint as $$
  select case p_role
    when 'admin'   then 1073741824  -- 1 GB
    when 'pro'     then 536870912   -- 512 MB
    when 'sponsor' then 536870912   -- 512 MB
    when 'user'    then 52428800    -- 50 MB
    else 1048576                    -- 1 MB: no account, one playground
  end;
$$ language sql immutable;

comment on function app_public.max_storage_bytes(app_public.user_role) is
  'How many bytes a writer of this role may store. No role means no account, which is one playground held by an edit key.';

create or replace function app_public.create_playground_commit(
  p_playground_name text,
  p_commit_message text,
  p_commit_data jsonb,
  p_playground_hash text default null,
  p_playground_description text default null,
  p_privacy app_public.privacy default 'secret',
  p_edit_key_hash bytea default null
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

  -- Nobody may store more than their role allows. For an account that is every
  -- playground it owns, counted together; with no account it is this
  -- playground, because one playground is all an edit key holds.
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
  elsif v_data_size > app_public.max_storage_bytes() then
    raise exception 'Storage limit exceeded' using errcode = 'DNIED';
  end if;

  -- Calculate expiration for anonymous playgrounds
  if v_user_id is null then
    v_expires_at := now() + app_public.calculate_retention(v_data_size);
  end if;

  if p_playground_hash is null then
    -- Without an account or a key the row would be unreachable the moment it
    -- is written: nothing could prove it may commit again. Refusing here keeps
    -- that state from existing, so one rule covers it instead of a constraint
    -- repeating it.
    if v_user_id is null and p_edit_key_hash is null then
      raise exception 'An anonymous playground needs an edit key'
        using errcode = 'MODAT';
    end if;

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
      expires_at,
      edit_key_hash
    ) values (
      v_playground_hash,
      p_playground_name,
      p_playground_description,
      coalesce(p_privacy, 'secret'::app_public.privacy),
      v_user_id,
      v_data_size,
      v_expires_at,
      case when v_user_id is null then p_edit_key_hash end
    );
  else
    -- Who may write here: the owner, an admin, or - when there is no owner -
    -- whoever presents the key the row was created with.
    select p.hash, p.head_commit_id into v_playground_hash, v_parent_id
    from app_public.playgrounds p
    where p.hash = p_playground_hash
      and (
        p.user_id = v_user_id
        or v_user_id in (
          select id from app_public.users where role = 'admin'
        )
        or (
          p.user_id is null
          and p_edit_key_hash is not null
          and p.edit_key_hash = p_edit_key_hash
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
