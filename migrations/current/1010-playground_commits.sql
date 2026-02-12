create table app_public.playground_commits (
  id text primary key default gen_random_uuid()::text,
  playground_hash text not null
    references app_public.playgrounds on delete cascade,
  parent_id text
    references app_public.playground_commits on delete set null,
  user_id uuid default app_public.current_user_id()
    references app_public.users on delete cascade,
  message text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create index on app_public.playground_commits (playground_hash);
create index on app_public.playground_commits (parent_id);
create index on app_public.playground_commits (user_id);
create index on app_public.playground_commits (created_at desc);

------------------------------------------------------------------------------------------------------------------------

alter table app_public.playground_commits enable row level security;

create policy select_own_and_playground_owner on app_public.playground_commits
  for select using (
    user_id = app_public.current_user_id()
    or exists (
      select 1 from app_public.playgrounds
      where hash = playground_hash
      and (privacy in ('public', 'secret') or user_id = app_public.current_user_id())
    )
  );

create policy insert_own on app_public.playground_commits
  for insert with check (
    user_id = app_public.current_user_id()
    or (user_id is null and app_public.current_user_id() is null)
  );

create policy delete_own on app_public.playground_commits
  for delete using (user_id = app_public.current_user_id());

create policy manage_all_as_admin on app_public.playground_commits
  for all using (exists (
    select 1 from app_public.users
    where id = app_public.current_user_id() and role = 'admin'
  ));

grant
  select,
  insert (playground_hash, parent_id, message, data),
  delete
  on app_public.playground_commits to :DATABASE_VISITOR;

------------------------------------------------------------------------------------------------------------------------

/*
 * Composite type for playground commit creation result
 * This type is returned by app_public.create_playground_commit function
 */
create type app_public.playground_commit_result as (
  commit_id text,
  playground_hash text,
  parent_id text,
  message text,
  created_at timestamptz
);

------------------------------------------------------------------------------------------------------------------------

/*
 * Calculate retention period for anonymous playgrounds based on data size
 * Uses 0x0.st formula: retention = min + (max - min) * (1 - size_ratio)^3
 */
create function app_public.calculate_retention(p_size_bytes bigint)
returns interval as $$
declare
  v_min_age interval := interval '30 days';
  v_max_age interval := interval '365 days';
  v_max_size bigint := 512 * 1024 * 1024;  -- 512MB
  v_size_ratio float;
  v_days float;
begin
  -- Normalize size (0 to 1)
  v_size_ratio := least(p_size_bytes::float / v_max_size, 1.0);

  -- Apply formula: retention = min + (max - min) * (1 - size)^3
  v_days := extract(epoch from v_min_age) / 86400 +
            (extract(epoch from v_max_age - v_min_age) / 86400) *
            power(1 - v_size_ratio, 3);

  return make_interval(days => v_days::int);
end;
$$ language plpgsql immutable;

------------------------------------------------------------------------------------------------------------------------

/*
 * Function to atomically create a playground commit
 *
 * This function handles:
 * - Creating a new playground if p_playground_hash is null
 * - Validating playground ownership if p_playground_hash is provided
 * - Finding the parent commit automatically
 * - Creating the commit with file data
 * - Supporting both authenticated and anonymous users
 *
 * All operations are atomic within a transaction with RLS enforced.
 *
 * Parameters:
 * 1. p_playground_name - Name for the playground (used if creating new, authenticated only)
 * 2. p_commit_message - Commit message describing the changes
 * 3. p_commit_data - JSONB containing files array: { files: [{ path, content }] }
 * 4. p_playground_hash - Optional: existing playground hash to add commit to
 * 5. p_playground_description - Optional: description for new playground
 *
 * Returns: playground_commit_result with commit and playground details
 */
create function app_public.create_playground_commit(
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
  v_expires_at timestamptz;
begin
  v_user_id := app_public.current_user_id();

  -- Calculate data size
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

      select app_public.max_storage_bytes(u.role) into v_max_size
      from app_public.users u
      where u.id = v_user_id;

      if v_total_size + v_data_size > v_max_size then
        raise exception 'Storage limit exceeded' using errcode = 'DNIED';
      end if;
    end;
  end if;

  -- Calculate expiration for anonymous playgrounds
  if v_user_id is null then
    v_expires_at := now() + app_public.calculate_retention(v_data_size);
  end if;

  -- If no playground_hash provided, create a new playground
  if p_playground_hash is null then
    -- Generate hash from commit data + timestamp for uniqueness
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
    select p.hash into v_playground_hash
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

  -- Find the latest commit for this playground to set as parent
  select c.id into v_parent_id
  from app_public.playground_commits c
  where c.playground_hash = v_playground_hash
  order by c.created_at desc
  limit 1;

  -- Create the commit
  insert into app_public.playground_commits (playground_hash, parent_id, message, data)
  values (v_playground_hash, v_parent_id, p_commit_message, p_commit_data)
  returning * into v_commit;

  -- Build the result
  v_result.commit_id := v_commit.id;
  v_result.playground_hash := v_commit.playground_hash;
  v_result.parent_id := v_commit.parent_id;
  v_result.message := v_commit.message;
  v_result.created_at := v_commit.created_at;

  return v_result;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

grant execute on function app_public.create_playground_commit to :DATABASE_VISITOR;

------------------------------------------------------------------------------------------------------------------------

/*
 * Fork an existing playground
 *
 * Creates a copy of the source playground with all its latest commit data.
 * The fork will reference the original playground via fork_hash.
 * User must be authenticated to fork.
 *
 * Parameters:
 * - p_source_hash: Hash of the playground to fork
 * - p_new_name: Optional name for the forked playground
 *
 * Returns: playground_commit_result for the initial commit of the fork
 */
create function app_public.fork_playground(
  p_source_hash text,
  p_new_name text default null
) returns app_public.playground_commit_result as $$
declare
  v_source app_public.playgrounds;
  v_latest_commit app_public.playground_commits;
  v_new_hash text;
  v_result app_public.playground_commit_result;
  v_user_id uuid;
begin
  v_user_id := app_public.current_user_id();

  -- Must be authenticated to fork
  if v_user_id is null then
    raise exception 'Must be logged in to fork a playground' using errcode = 'LOGIN';
  end if;

  -- Get latest commit
  select * into v_latest_commit
  from app_public.playground_commits
  where playground_hash = p_source_hash
  order by created_at desc
  limit 1;

  if v_latest_commit is null then
    raise exception 'Source playground has no commits' using errcode = 'DNIED';
  end if;

  -- Generate new hash for fork
  v_new_hash := substring(
    encode(digest(v_latest_commit.data::text || now()::text || v_user_id::text, 'sha256'), 'hex'),
    1, 12
  );

  -- Create new playground with fork reference
  insert into app_public.playgrounds (hash, name, description, privacy, user_id, fork_hash, data_size)
  values (
    v_new_hash,
    coalesce(p_new_name, 'fork-of-' || substring(p_source_hash, 1, 8)),
    'Forked from ' || coalesce(v_source.name, p_source_hash),
    'private'::app_public.privacy,
    v_user_id,
    p_source_hash,
    v_source.data_size
  );

  -- Create initial commit with same data as source
  insert into app_public.playground_commits (playground_hash, parent_id, message, data)
  values (
    v_new_hash,
    null,  -- No parent (fresh fork)
    'Initial commit (forked from ' || p_source_hash || ')',
    v_latest_commit.data
  )
  returning * into v_latest_commit;

  -- Build result
  v_result.commit_id := v_latest_commit.id;
  v_result.playground_hash := v_new_hash;
  v_result.parent_id := null;
  v_result.message := v_latest_commit.message;
  v_result.created_at := v_latest_commit.created_at;

  return v_result;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

grant execute on function app_public.fork_playground to :DATABASE_VISITOR;

------------------------------------------------------------------------------------------------------------------------

/*
 * Delete expired anonymous playgrounds
 *
 * This function should be run periodically (e.g., daily via cron job).
 * It removes anonymous playgrounds that have passed their expiration date.
 *
 * Returns: Count of deleted playgrounds
 */
create function app_private.prune_expired_playgrounds()
returns table(deleted_count int) as $$
declare
  v_deleted int;
begin
  -- Delete expired anonymous playgrounds
  with deleted as (
    delete from app_public.playgrounds
    where user_id is null
      and expires_at is not null
      and expires_at < now()
    returning hash
  )
  select count(*)::int into v_deleted from deleted;

  return query select v_deleted;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

comment on function app_private.prune_expired_playgrounds() is
  E'Removes anonymous playgrounds that have passed their expiration date. Should be run periodically via cron.';
