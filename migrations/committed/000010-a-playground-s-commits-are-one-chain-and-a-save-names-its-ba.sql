--! Previous: sha1:c8f931824af23a674a8a2fc678b894c1eb7e10b8
--! Hash: sha1:5513581856e90d4060d3c775a731ddbe3cbaaf01
--! Message: a playground's commits are one chain, and a save names its basis

--! split: 1-current.sql
-- A playground's commits are one chain: one root, each commit the parent of at
-- most one other, every parent in the same playground, and the head at the
-- end. The history views count versions along that chain, so the database
-- keeps it whole rather than leaving the views to guess at a branch.

-- Existing data that breaks the chain makes the constraints below fail with a
-- bare constraint name. Refusing first says what is wrong and how much of it;
-- repairing it is a separate decision, because every repair rewrites history.
do $$
declare
  v_off_chain bigint;
  v_headless bigint;
  v_foreign_parent bigint;
begin
  with recursive chain as (
    select c.id, c.parent_id, c.playground_hash
    from app_public.playground_commits c
    join app_public.playgrounds p on p.head_commit_id = c.id and p.hash = c.playground_hash
    union all
    select c.id, c.parent_id, c.playground_hash
    from app_public.playground_commits c
    join chain on chain.parent_id = c.id and chain.playground_hash = c.playground_hash
  )
  select count(*) into v_off_chain
  from app_public.playground_commits c
  where not exists (select 1 from chain where chain.id = c.id);

  select count(*) into v_headless
  from app_public.playgrounds p
  where p.head_commit_id is null
    and exists (select 1 from app_public.playground_commits c where c.playground_hash = p.hash);

  select count(*) into v_foreign_parent
  from app_public.playground_commits c
  join app_public.playground_commits parent on parent.id = c.parent_id
  where parent.playground_hash <> c.playground_hash;

  if v_off_chain + v_headless + v_foreign_parent > 0 then
    raise exception 'Commits break their playground''s chain: % off the chain from the head, % playgrounds with commits and no head, % commits whose parent is in another playground',
      v_off_chain, v_headless, v_foreign_parent;
  end if;
end;
$$;

alter table app_public.playground_commits
  drop constraint if exists playground_commits_parent_id_fkey,
  drop constraint if exists playground_commits_parent_in_playground,
  drop constraint if exists playground_commits_one_child,
  drop constraint if exists playground_commits_playground_hash_id_key;

drop index if exists app_public.playground_commits_parent_id_idx;
drop index if exists app_public.playground_commits_one_root;

-- The foreign key takes no delete action, so a commit with a child cannot be
-- deleted: only the head can, and the trigger below steps the head back. A
-- rule that re-linked the child instead would have to update rows the same
-- cascade deletes, and Postgres refuses that when a playground or its owner
-- is deleted.
alter table app_public.playground_commits
  add constraint playground_commits_playground_hash_id_key unique (playground_hash, id),
  add constraint playground_commits_one_child unique (parent_id),
  add constraint playground_commits_parent_in_playground
    foreign key (playground_hash, parent_id)
    references app_public.playground_commits (playground_hash, id);

create unique index playground_commits_one_root
  on app_public.playground_commits (playground_hash)
  where parent_id is null;

create or replace function app_private.tg_playground_commits__step_head_back() returns trigger as $$
begin
  -- The commit going has no child, so if the playground names it, the parent
  -- is the new head, and the stored size follows the head as it does on a save.
  update app_public.playgrounds p
  set head_commit_id = old.parent_id,
      data_size = coalesce(
        (select length(c.data::text) from app_public.playground_commits c where c.id = old.parent_id),
        0
      )
  where p.hash = old.playground_hash
    and p.head_commit_id = old.id;
  return old;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

drop trigger if exists _100_step_head_back on app_public.playground_commits;
create trigger _100_step_head_back
  before delete on app_public.playground_commits
  for each row execute function app_private.tg_playground_commits__step_head_back();

-- Every commit is written by create_playground_commit or fork_playground,
-- which check the basis and keep the head. A direct insert would do neither.
drop policy if exists insert_own on app_public.playground_commits;
revoke insert on app_public.playground_commits from :DATABASE_VISITOR;

drop function if exists app_public.create_playground_commit(text, text, jsonb, text, text, app_public.privacy, bytea);
drop function if exists app_public.create_playground_commit(text, text, jsonb, text, text, app_public.privacy, bytea, text);

-- p_basis_commit_id is the commit the saved files were edited from. A save to
-- an existing playground is taken only while that commit is still the head:
-- otherwise someone saved in between, and taking this save would discard
-- their work without a word. The row lock makes two saves on one basis wait
-- for each other, so the second sees the first one's head and is refused.
create function app_public.create_playground_commit(
  p_playground_name text,
  p_commit_message text,
  p_commit_data jsonb,
  p_playground_hash text default null,
  p_playground_description text default null,
  p_privacy app_public.privacy default 'secret',
  p_edit_key_hash bytea default null,
  p_basis_commit_id text default null
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
    -- whoever presents the key the row was created with. This is asked before
    -- the basis, so a caller with no right learns nothing about the head.
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
      )
    for update of p;

    if v_playground_hash is null then
      raise exception 'Playground not found or access denied' using errcode = 'DNIED';
    end if;

    if v_parent_id is distinct from p_basis_commit_id then
      raise exception 'This playground has a newer version than the one you edited'
        using errcode = 'STALE';
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
