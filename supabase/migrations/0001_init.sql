-- 영어 회화 친구 앱 — 초기 스키마
-- 모든 테이블은 로그인한 본인 행만 읽고 쓸 수 있다 (RLS).

-- 설정 (레벨·친구 이름·목표 시간 등). 폰·PC에서 같은 설정을 쓰기 위해 DB에 둔다.
create table if not exists public.settings (
  user_id    uuid primary key default auth.uid() references auth.users on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  minutes       numeric(6,1) not null default 0,
  mode          text not null check (mode in ('free','scenario','diagnosis')),
  scenario      int,
  level         int not null check (level between 1 and 5),
  user_turns    int not null default 0,
  english_turns int not null default 0,
  summary_json  jsonb
);
create index if not exists sessions_user_started on public.sessions (user_id, started_at desc);

create table if not exists public.messages (
  id            bigint generated always as identity primary key,
  user_id       uuid not null default auth.uid() references auth.users on delete cascade,
  session_id    uuid not null references public.sessions on delete cascade,
  role          text not null check (role in ('user','assistant')),
  text          text not null,
  ko            text,
  repeat        text,
  recast        jsonb,
  spoke_english boolean,
  created_at    timestamptz not null default now()
);
create index if not exists messages_session_created on public.messages (session_id, created_at);
create index if not exists messages_user_created on public.messages (user_id, created_at desc);

create table if not exists public.phrases (
  id                bigint generated always as identity primary key,
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  english           text not null,
  english_norm      text generated always as (lower(trim(english))) stored,
  korean            text,
  example           text,
  source_session_id uuid references public.sessions on delete set null,
  status            text not null default 'new' check (status in ('new','learning','known')),
  next_review_at    timestamptz not null default (now() + interval '1 day'),
  interval_days     int not null default 1,
  created_at        timestamptz not null default now(),
  constraint phrases_user_english unique (user_id, english_norm)
);
create index if not exists phrases_user_due on public.phrases (user_id, next_review_at);
create index if not exists phrases_source_session on public.phrases (source_session_id);

alter table public.settings enable row level security;
alter table public.sessions enable row level security;
alter table public.messages enable row level security;
alter table public.phrases  enable row level security;

create policy "own settings" on public.settings for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own sessions" on public.sessions for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own messages" on public.messages for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "own phrases" on public.phrases for all
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
