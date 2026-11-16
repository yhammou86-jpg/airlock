-- Airlock optional history schema (Supabase / plain Postgres 15+)
--
-- The product runs without this database: dashboard and relay are stateless and
-- files never leave the two paired devices. Apply this migration only if you
-- want accounts, device inventory, transfer history and an audit trail.
--
--   supabase db push          (with the Supabase CLI)
--   psql "$DATABASE_URL" -f supabase/migrations/001_init.sql
--
-- Everything is protected by row level security keyed on auth.uid(). The relay
-- deliberately has no database credentials.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ devices
create table if not exists public.devices (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80),
  model           text,
  android_version text,
  app_version     text,
  fingerprint     text,                       -- stable installation id
  public_key      text,                       -- reserved for E2E payload keys
  last_seen_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (owner_id, fingerprint)
);

comment on column public.devices.fingerprint is
  'Random install id reported by the agent; not a hardware identifier.';

-- ------------------------------------------------------------------ pairings
create table if not exists public.pairings (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  device_id   uuid references public.devices (id) on delete set null,
  label       text,
  code_hash   text not null,                  -- sha256(salt || code), never the code
  room        text,
  transport   text not null default 'relay' check (transport in ('lan', 'relay', 'webrtc')),
  expires_at  timestamptz not null,
  claimed_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists pairings_expiry_idx on public.pairings (expires_at)
  where claimed_at is null and revoked_at is null;

-- ------------------------------------------------------------------ sessions
create table if not exists public.sessions (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  device_id   uuid references public.devices (id) on delete cascade,
  pairing_id  uuid references public.pairings (id) on delete set null,
  transport   text not null check (transport in ('lan', 'relay', 'webrtc')),
  user_agent  text,
  remote_addr inet,
  bytes_in    bigint not null default 0,
  bytes_out   bigint not null default 0,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz
);

create index if not exists sessions_device_idx on public.sessions (device_id, started_at desc);

-- ------------------------------------------------------------------ messages
create table if not exists public.sms_messages (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  device_id   uuid references public.devices (id) on delete cascade,
  thread_id   text not null,
  address     text not null,
  direction   text not null check (direction in ('in', 'out')),
  body        text not null,
  sent_at     timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists sms_thread_idx on public.sms_messages (device_id, thread_id, sent_at desc);

create table if not exists public.notifications (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  device_id   uuid references public.devices (id) on delete cascade,
  app         text not null,
  package     text,
  title       text,
  body        text,
  posted_at   timestamptz not null,
  dismissed_at timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists notifications_recent_idx on public.notifications (device_id, posted_at desc);

-- ------------------------------------------------------------------ transfers
create table if not exists public.transfers (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  device_id   uuid references public.devices (id) on delete cascade,
  direction   text not null check (direction in ('up', 'down')),
  remote_path text not null,
  name        text not null,
  bytes       bigint not null default 0,
  sha256      text,
  status      text not null default 'ok' check (status in ('ok', 'failed', 'cancelled')),
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------------ audit
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  device_id   uuid references public.devices (id) on delete set null,
  action      text not null,                  -- e.g. mirror.start, input.tap, sms.send
  detail      jsonb not null default '{}'::jsonb,
  remote_addr inet,
  created_at  timestamptz not null default now()
);

create index if not exists audit_log_owner_idx on public.audit_log (owner_id, created_at desc);

-- ------------------------------------------------------------------ RLS
alter table public.devices       enable row level security;
alter table public.pairings      enable row level security;
alter table public.sessions      enable row level security;
alter table public.sms_messages  enable row level security;
alter table public.notifications enable row level security;
alter table public.transfers     enable row level security;
alter table public.audit_log     enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['devices','pairings','sessions','sms_messages','notifications','transfers','audit_log'] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_all', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid())',
      t || '_owner_all', t
    );
  end loop;
end $$;

-- Inserts must always name the caller as owner; the with check above enforces
-- it, and this trigger keeps updated rows honest.
create or replace function public.touch_device()
returns trigger language plpgsql as $$
begin
  new.owner_id := old.owner_id;
  new.created_at := old.created_at;
  return new;
end $$;

drop trigger if exists devices_owner_guard on public.devices;
create trigger devices_owner_guard
  before update on public.devices
  for each row execute function public.touch_device();

-- Handy view: device plus its most recent activity, still owner-scoped because
-- views run with the caller's permissions (security_invoker).
create or replace view public.device_overview
with (security_invoker = true) as
select
  d.id,
  d.name,
  d.model,
  d.android_version,
  d.last_seen_at,
  (select count(*) from public.sessions s where s.device_id = d.id) as session_count,
  (select count(*) from public.transfers t where t.device_id = d.id) as transfer_count,
  (select max(s.started_at) from public.sessions s where s.device_id = d.id) as last_session_at
from public.devices d;
