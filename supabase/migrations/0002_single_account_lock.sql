-- 계정 1개 잠금: 첫 계정이 생긴 뒤에는 어떤 경로로도 새 계정을 만들 수 없다.
-- (대시보드의 "Allow new users to sign up" 끄기와 별개로 DB에서 한 번 더 막는 안전장치)
-- 계정을 새로 만들어야 하면 기존 계정을 먼저 지운다.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function private.block_extra_signups()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from auth.users where id <> new.id) then
    raise exception 'Sign-ups are closed (single-account app)';
  end if;
  return new;
end;
$$;
revoke execute on function private.block_extra_signups() from public, anon, authenticated;

drop trigger if exists block_extra_signups on auth.users;
create trigger block_extra_signups
  before insert on auth.users
  for each row execute function private.block_extra_signups();
