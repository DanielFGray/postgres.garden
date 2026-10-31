--! Previous: sha1:ef2f837979b25b35c0c3112d7bd123245f03f622
--! Hash: sha1:04ff045773afd6c8c4a3b1bcf94f1572346f585f

--! split: 1-current.sql
-- Whoever holds a playground may change what it says about itself.

-- A metadata change was an update against the playgrounds table, authorised by
-- the update_own_or_admin policy, which matches user_id against the caller. An
-- anonymous playground has no user_id, so the one writer it does have - whoever
-- holds its edit key - could change its files and nothing else. The save notice
-- promises them the playground, and the privacy dropdown is the only way to
-- make a playground public, so that promise has to hold here too.
--
-- The rule lives where the save's rule lives: one security definer function
-- that decides who may write, by account, by admin, or by the key the row was
-- created with. The policy stays for anything that writes the table directly
-- and must not contradict this.
--
-- The patch arrives as jsonb because a present key and an absent one mean
-- different things: {"description": null} clears the description, while a patch
-- without that key leaves it alone. Three nullable parameters cannot say that.
-- A return type cannot be changed in place, and this migration is re-applied
-- from the top every time it changes, so the old shape goes first.
drop function if exists app_public.update_playground(text, jsonb, bytea);

create function app_public.update_playground(
  p_hash text,
  p_patch jsonb,
  p_edit_key_hash bytea default null
) returns setof app_public.playgrounds as $$
declare
  v_user_id uuid;
  v_playground app_public.playgrounds;
begin
  v_user_id := app_public.current_user_id();

  update app_public.playgrounds p
  set name = case when p_patch ? 'name' then p_patch->>'name' else p.name end,
      description = case
        when p_patch ? 'description' then p_patch->>'description'
        else p.description
      end,
      privacy = case
        when p_patch ? 'privacy' then (p_patch->>'privacy')::app_public.privacy
        else p.privacy
      end
  where p.hash = p_hash
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
  returning p.* into v_playground;

  -- Answering with no rows, rather than with a row of nulls, is what makes a
  -- refusal legible to the caller: a playground they may not write to is one
  -- they cannot tell from a playground that is not there, and both say the
  -- same thing here.
  if found then
    return next v_playground;
  end if;

  return;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

comment on function app_public.update_playground(text, jsonb, bytea) is
  'Changes a playground''s name, description or privacy for its owner, an admin, or the holder of its edit key. Keys present in the patch are the fields to set.';

grant execute on function app_public.update_playground(text, jsonb, bytea) to :DATABASE_VISITOR;
