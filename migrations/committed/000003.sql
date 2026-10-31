--! Previous: sha1:6356e6c8bdc7c99a4a43481d6c48503b3e369248
--! Hash: sha1:1ec3553d6796930962ca00335f81f516509b90a8

--! split: 1-current.sql
-- Let the caller choose a new playground's privacy.
--
-- create_playground_commit always inserted 'secret', so a playground the author
-- meant to keep private was reachable by anyone holding the link until they
-- changed it afterwards. The parameter defaults to 'secret', so a caller that
-- says nothing gets what it got before.
--
-- The insert coalesces as well as defaulting, because a caller using named
-- arguments cannot say "use the default" — it either names the parameter or
-- omits it, and a client that forwards an absent privacy as NULL would
-- otherwise write NULL into a NOT NULL column. NULL and absent both mean the
-- caller did not choose.
--
-- Entitlement is not checked here. The _200_privacy_entitlement trigger on
-- app_public.playgrounds refuses 'private' for an anonymous or non-sponsor
-- author, and it fires on this insert like any other, so the database stays the
-- one place that decides. A check in this function would be a second copy of
-- that rule.
--
-- The old signature has to go rather than be replaced: a sixth parameter with a
-- default does not replace the five-parameter function, it overloads it, and a
-- five-argument call would then match both and fail as ambiguous.
drop function if exists app_public.create_playground_commit(text, text, jsonb, text, text);

create or replace function app_public.create_playground_commit(
  p_playground_name text,
  p_commit_message text,
  p_commit_data jsonb,
  p_playground_hash text default null,
  p_playground_description text default null,
  p_privacy app_public.privacy default 'secret'
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
      coalesce(p_privacy, 'secret'::app_public.privacy),
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


-- The drop above took the grant with it.
grant execute on function app_public.create_playground_commit to :DATABASE_VISITOR;
