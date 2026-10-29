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

