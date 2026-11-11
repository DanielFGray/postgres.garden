--! Previous: sha1:4fa24ddf64d15c029bca1dbb9f2b606084168629
--! Hash: sha1:c8f931824af23a674a8a2fc678b894c1eb7e10b8

--! split: 1-current.sql
-- Reset, verification and account-deletion tokens, as effect-web-template
-- stores them.
--
-- A token is 32 random bytes. The database keeps only its sha256 hash, so a
-- read of the secrets tables gives no working link. SQL mints a fresh token
-- for each email and puts the plaintext only in the worker job that mails it.
-- The token alone finds its row, so a link carries no user or email id.
--
-- The plaintext columns are dropped with their pending tokens. Every link sent
-- before this migration carries its token in the query string, which the app
-- no longer reads, so those tokens could not be used anyway; an unverified
-- address gets a new link from "resend".

create or replace function app_private.hash_token(p_token text) returns text as $$
begin
  return encode(digest(decode(p_token, 'hex'), 'sha256'), 'hex');
exception when others then
  -- Not hex: no stored hash can match it.
  return null;
end;
$$ language plpgsql immutable set search_path to pg_catalog, public, pg_temp;

create or replace function app_private.reset_password_token_lifetime() returns interval as $$
  select interval '1 hour';
$$ language sql immutable;

create or replace function app_private.email_verification_token_lifetime() returns interval as $$
  select interval '24 hours';
$$ language sql immutable;

create or replace function app_private.delete_account_token_lifetime() returns interval as $$
  select interval '1 hour';
$$ language sql immutable;

/**********/

alter table app_private.user_secrets drop column if exists reset_password_token;
alter table app_private.user_secrets add column if not exists reset_password_token_hash text;
create index if not exists user_secrets_reset_password_token_hash_idx
  on app_private.user_secrets (reset_password_token_hash)
  where reset_password_token_hash is not null;

alter table app_private.user_secrets drop column if exists delete_account_token;
alter table app_private.user_secrets add column if not exists delete_account_token_hash text;
create index if not exists user_secrets_delete_account_token_hash_idx
  on app_private.user_secrets (delete_account_token_hash)
  where delete_account_token_hash is not null;

alter table app_private.user_email_secrets drop column if exists verification_token;
alter table app_private.user_email_secrets add column if not exists verification_token_hash text;
alter table app_private.user_email_secrets add column if not exists verification_token_generated timestamptz;
create index if not exists user_email_secrets_verification_token_hash_idx
  on app_private.user_email_secrets (verification_token_hash)
  where verification_token_hash is not null;

/**********/

-- The secrets trigger now queues the verification mail itself, because only it
-- holds the plaintext token.
drop trigger if exists _900_send_verification_email on app_public.user_emails;

create or replace function app_private.tg__user_email_secrets__insert_with_user_email() returns trigger as $$
declare
  v_token text;
begin
  if NEW.is_verified is false then
    v_token := encode(gen_random_bytes(32), 'hex');
    insert into app_private.user_email_secrets(
      user_email_id,
      verification_token_hash,
      verification_token_generated
    ) values (
      NEW.id,
      app_private.hash_token(v_token),
      now()
    );
    perform graphile_worker.add_job(
      'user_emails__send_verification',
      json_build_object('id', NEW.id, 'token', v_token)
    );
  else
    insert into app_private.user_email_secrets(user_email_id) values(NEW.id);
  end if;
  return NEW;
end;
$$ language plpgsql volatile security definer set search_path to pg_catalog, public, pg_temp;

/**********/

drop function if exists app_public.verify_email(uuid, text);

/*
 * Marks the address whose pending token is `token` as verified. The token
 * alone identifies the address. It is used once: a verified address loses its
 * token hash.
 */
create or replace function app_public.verify_email(token text) returns boolean as $$
declare
  v_user_email_id uuid;
begin
  select user_email_id into v_user_email_id
  from app_private.user_email_secrets
  where verification_token_hash = app_private.hash_token(token)
    and verification_token_generated > now() - app_private.email_verification_token_lifetime();

  if v_user_email_id is null then
    return false;
  end if;

  update app_public.user_emails
  set
    is_verified = true,
    is_primary = is_primary or not exists(
      select 1 from app_public.user_emails other_email
      where other_email.user_id = user_emails.user_id and other_email.is_primary is true
    )
  where id = v_user_email_id
    and is_verified is false;

  if found then
    update app_private.user_email_secrets
    set verification_token_hash = null,
        verification_token_generated = null
    where user_email_id = v_user_email_id;
    return true;
  end if;

  return false;
end;
$$ language plpgsql strict volatile security definer set search_path to pg_catalog, public, pg_temp;

/*
 * Mails a new verification link to one of the caller's unverified addresses.
 * The new token replaces the old one, so a link mailed before stops working.
 *
 * A token minted less than 3 minutes ago is kept, and nothing is mailed: its
 * mail is sent or on its way. A new token would kill that link, and the
 * worker would mail the new one, so the limit is checked here, where the token
 * is minted.
 */
create or replace function app_public.resend_email_verification_code(email_id uuid) returns boolean as $$
declare
  v_token text;
begin
  if not exists(
    select 1
    from app_public.user_emails
    join app_private.user_email_secrets on user_email_secrets.user_email_id = user_emails.id
    where user_emails.id = email_id
    and user_id = app_public.current_user_id()
    and is_verified is false
    and (
      verification_token_generated is null
      or verification_token_generated <= now() - interval '3 minutes'
    )
  ) then
    return false;
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  update app_private.user_email_secrets
  set
    verification_token_hash = app_private.hash_token(v_token),
    verification_token_generated = now()
  where user_email_id = email_id;

  perform graphile_worker.add_job(
    'user_emails__send_verification',
    json_build_object('id', email_id, 'token', v_token)
  );
  return true;
end;
$$ language plpgsql strict volatile security definer set search_path to pg_catalog, public, pg_temp;

/**********/

create or replace function app_public.forgot_password(email citext) returns void as $$
declare
  v_user_email app_public.user_emails;
  v_token text;
  v_token_min_duration_between_emails interval = interval '3 minutes';
  v_now timestamptz = clock_timestamp(); -- Function can be called multiple during transaction
  v_latest_attempt timestamptz;
begin
  -- Find the matching user_email:
  select user_emails.* into v_user_email
  from app_public.user_emails
  where user_emails.email = forgot_password.email
  order by is_verified desc, id desc;

  -- If there is no match:
  if v_user_email is null then
    -- This email doesn't exist in the system; trigger an email stating as much.

    -- We do not allow this email to be triggered more than once every 15
    -- minutes, so we need to track it:
    insert into app_private.unregistered_email_password_resets (email, latest_attempt)
      values (forgot_password.email, v_now)
      on conflict on constraint unregistered_email_pkey
      do update
        set latest_attempt = v_now, attempts = unregistered_email_password_resets.attempts + 1
        where unregistered_email_password_resets.latest_attempt < v_now - interval '15 minutes'
      returning latest_attempt into v_latest_attempt;

    if v_latest_attempt = v_now then
      perform graphile_worker.add_job(
        'user__forgot_password_unregistered_email',
        json_build_object('email', forgot_password.email::text)
      );
    end if;

    return;
  end if;

  -- There was a match.
  -- See if we've triggered a reset recently:
  if exists(
    select 1
    from app_private.user_email_secrets
    where user_email_id = v_user_email.id
    and password_reset_email_sent_at is not null
    and password_reset_email_sent_at > v_now - v_token_min_duration_between_emails
  ) then
    -- If so, take no action.
    return;
  end if;

  -- A fresh token each time: only the job that mails it holds the plaintext.
  v_token := encode(gen_random_bytes(32), 'hex');
  update app_private.user_secrets
  set
    reset_password_token_hash = app_private.hash_token(v_token),
    reset_password_token_generated = v_now
  where user_id = v_user_email.user_id;

  -- Don't allow spamming an email:
  update app_private.user_email_secrets
  set password_reset_email_sent_at = v_now
  where user_email_id = v_user_email.id;

  perform graphile_worker.add_job(
    'user__forgot_password',
    json_build_object('id', v_user_email.user_id, 'email', v_user_email.email::text, 'token', v_token)
  );
end;
$$ language plpgsql strict security definer volatile set search_path to pg_catalog, public, pg_temp;

/**********/

drop function if exists app_private.reset_password(uuid, text, text);

/*
 * The second half of a password reset: `reset_token` alone finds the account.
 * A token that matches no account cannot name one to lock, so only an expired
 * token counts as a failed attempt; a guess at a 32-byte token is not
 * feasible, and the route's rate limit bounds the tries.
 */
create or replace function app_private.reset_password(
  reset_token text,
  new_password text
) returns boolean as $$
declare
  v_user_secret app_private.user_secrets;
  v_lockout_window interval = app_private.reset_password_token_lifetime();
begin
  select * into v_user_secret
  from app_private.user_secrets
  where reset_password_token_hash = app_private.hash_token(reset_token);

  if not found then
    return null;
  end if;

  -- Have there been too many reset attempts?
  if (
    v_user_secret.first_failed_reset_password_attempt is not null
    and v_user_secret.first_failed_reset_password_attempt > now() - v_lockout_window
    and v_user_secret.failed_reset_password_attempts >= 20
  ) then
    raise exception 'Password reset locked - too many reset attempts' using errcode = 'LOCKD';
  end if;

  if v_user_secret.reset_password_token_generated is null
    or v_user_secret.reset_password_token_generated <= now() - app_private.reset_password_token_lifetime() then
    update app_private.user_secrets
    set
      failed_reset_password_attempts = (case when first_failed_reset_password_attempt is null or first_failed_reset_password_attempt < now() - v_lockout_window then 1 else failed_reset_password_attempts + 1 end),
      first_failed_reset_password_attempt = (case when first_failed_reset_password_attempt is null or first_failed_reset_password_attempt < now() - v_lockout_window then now() else first_failed_reset_password_attempt end)
    where user_secrets.user_id = v_user_secret.user_id;
    return null;
  end if;

  perform app_private.assert_valid_password(new_password);

  update app_private.user_secrets
  set
    password_hash = crypt(new_password, gen_salt('bf')),
    failed_password_attempts = 0,
    first_failed_password_attempt = null,
    reset_password_token_hash = null,
    reset_password_token_generated = null,
    failed_reset_password_attempts = 0,
    first_failed_reset_password_attempt = null
  where user_secrets.user_id = v_user_secret.user_id;

  -- Revoke the user's sessions
  delete from app_private.sessions
  where sessions.user_id = v_user_secret.user_id;

  perform graphile_worker.add_job(
    'user__audit',
    json_build_object(
      'type', 'reset_password',
      'user_id', v_user_secret.user_id,
      'current_user_id', app_public.current_user_id()
    ));
  return true;
end;
$$ language plpgsql strict volatile;

/**********/

/*
 * Mails the caller a link that confirms the deletion of their account. Each
 * request mints a new token, so a link mailed before stops working.
 */
create or replace function app_public.request_account_deletion() returns boolean as $$
declare
  v_user_email app_public.user_emails;
  v_token text;
begin
  if app_public.current_user_id() is null then
    raise exception 'You must log in to delete your account' using errcode = 'LOGIN';
  end if;

  -- Get the email to send account deletion token to
  select * into v_user_email
    from app_public.user_emails
    where user_id = app_public.current_user_id()
    order by is_primary desc, is_verified desc, id desc
    limit 1;

  v_token := encode(gen_random_bytes(32), 'hex');
  update app_private.user_secrets
  set
    delete_account_token_hash = app_private.hash_token(v_token),
    delete_account_token_generated = now()
  where user_id = app_public.current_user_id();

  perform graphile_worker.add_job(
    'user__send_delete_account_email',
    json_build_object('email', v_user_email.email::text, 'token', v_token)
  );
  return true;
end;
$$ language plpgsql strict security definer volatile set search_path to pg_catalog, public, pg_temp;

/*
 * Deletes the caller's account when `token` is their pending deletion token.
 * The token must belong to the caller: a link opened while signed in to
 * another account deletes nothing.
 */
create or replace function app_public.confirm_account_deletion(token text) returns boolean as $$
declare
  v_user_secret app_private.user_secrets;
begin
  if app_public.current_user_id() is null then
    raise exception 'You must log in to delete your account' using errcode = 'LOGIN';
  end if;

  select * into v_user_secret
    from app_private.user_secrets
    where user_secrets.user_id = app_public.current_user_id();

  if v_user_secret is null then
    -- Success: they're already deleted
    return true;
  end if;

  if (
    v_user_secret.delete_account_token_generated > now() - app_private.delete_account_token_lifetime()
  and
    v_user_secret.delete_account_token_hash = app_private.hash_token(token)
  ) then
    delete from app_public.users where id = app_public.current_user_id();
    return true;
  end if;

  raise exception 'The supplied token was incorrect - perhaps you''re logged in to the wrong account, or the token has expired?' using errcode = 'DNIED';
end;
$$ language plpgsql strict volatile security definer set search_path to pg_catalog, public, pg_temp;
