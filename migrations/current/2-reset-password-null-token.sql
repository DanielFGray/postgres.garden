-- Rejects a password reset when no reset is pending.
--
-- `user_secrets.reset_password_token` is NULL for every user without a pending
-- reset. A comparison with NULL yields NULL, and an `if` treats NULL as false,
-- so a reject branch guarded by a plain inequality is skipped. The check
-- therefore rejects NULL explicitly, and the success path needs a positive match.
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
    or v_user_secret.reset_password_token is distinct from reset_token then
    -- Wrong token, bump all the attempt tracking figures
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
