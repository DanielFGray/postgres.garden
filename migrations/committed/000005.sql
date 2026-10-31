--! Previous: sha1:9ef12768932f0d3d594fbbdcdf7385035fcdcfe2
--! Hash: sha1:138b54e512d3e460fc9f554950e20fe006f048a7

--! split: 1-current.sql
-- An anonymous playground is held by whoever has its edit key.
--
-- An anonymous save had nowhere to go: create_playground_commit accepted a null
-- author, but the row it wrote had no owner and no secret, so nothing could
-- ever commit to it again. The client worked around that by not saving at all -
-- it packed the whole workspace into a /s/<base64> link and gave up over 8KB.
--
-- A playground created without an author now carries the digest of a key the
-- server hands back once. Presenting the key is how a later commit proves it
-- may write, since there is no account to match against. The server holds the
-- plaintext just long enough to return it, and only the digest is stored, so a
-- database dump cannot be used to edit anyone's playground.
alter table app_public.playgrounds
  add column if not exists edit_key_hash bytea;

comment on column app_public.playgrounds.edit_key_hash is
  'SHA-256 of the edit key an anonymous playground is held by. Null once an account owns the row.';

-- The anonymous insert policy refused a name, because an anonymous author had
-- no way to come back and the name was dropped on the way in anyway. A key
-- holder can come back, so the name is theirs to set and the policy must not
-- say otherwise. Like insert_authenticated this is unreachable while every
-- write goes through a security definer function, and like it, it must not
-- contradict the function that is reachable.
drop policy if exists insert_anonymous on app_public.playgrounds;
create policy insert_anonymous on app_public.playgrounds
  for insert with check (
    user_id is null
    and privacy in ('public', 'secret')
  );

-- The old signature has to go rather than be replaced: a seventh parameter with
-- a default does not replace the six-parameter function, it overloads it, and a
-- six-argument call would then match both and fail as ambiguous.
drop function if exists app_public.create_playground_commit(text, text, jsonb, text, text, app_public.privacy);

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

grant execute on function app_public.create_playground_commit to :DATABASE_VISITOR;

-- Signing in while holding the key is how an anonymous playground gets an
-- owner. The key stops being the way in, and the row stops expiring.
--
-- The storage limit is not re-checked here. It is a rule about writing, and
-- create_playground_commit applies it on the claimer's next commit, which is
-- the one place it is stated.
create or replace function app_public.claim_playground(
  p_hash text,
  p_edit_key_hash bytea
) returns app_public.playgrounds as $$
declare
  v_user_id uuid;
  v_playground app_public.playgrounds;
begin
  v_user_id := app_public.current_user_id();

  if v_user_id is null then
    raise exception 'Must be logged in to claim a playground' using errcode = 'LOGIN';
  end if;

  update app_public.playgrounds
  set user_id = v_user_id,
      edit_key_hash = null,
      expires_at = null
  where hash = p_hash
    and user_id is null
    and edit_key_hash = p_edit_key_hash
  returning * into v_playground;

  if v_playground.hash is null then
    raise exception 'Playground not found or access denied' using errcode = 'DNIED';
  end if;

  return v_playground;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

comment on function app_public.claim_playground(text, bytea) is
  'Takes ownership of an anonymous playground on presentation of its edit key.';

grant execute on function app_public.claim_playground(text, bytea) to :DATABASE_VISITOR;
