-- GitHub Project Pusher persistent storage schema.
-- Run this once in Supabase SQL Editor.
-- The application uses the service-role key server-side; no Supabase secret belongs in public/.

create table if not exists public.users (
  id text primary key,
  login text not null,
  name text,
  avatar text,
  email text,
  github_token_enc text not null,
  github_refresh_token_enc text,
  github_expires_at timestamptz,
  github_refresh_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  id text primary key,
  user_id text references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_id_idx on public.sessions(user_id);
create index if not exists sessions_expires_at_idx on public.sessions(expires_at);

create table if not exists public.oauth_attempts (
  state_hash text primary key,
  code_verifier text not null,
  return_to text,
  client_cookie_hash text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists oauth_attempts_expires_at_idx on public.oauth_attempts(expires_at);
alter table public.oauth_attempts add column if not exists client_cookie_hash text;
alter table public.users add column if not exists email text;

create table if not exists public.login_codes (
  code_hash text primary key,
  user_id text not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists login_codes_expires_at_idx on public.login_codes(expires_at);

create table if not exists public.sse_tickets (
  ticket_hash text primary key,
  user_id text not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sse_tickets_expires_at_idx on public.sse_tickets(expires_at);

create table if not exists public.projects (
  id uuid primary key,
  user_id text not null references public.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sync_state text not null default 'local',
  sync_message text,
  repo_id text,
  repo_full_name text,
  repo_url text,
  remote_url text,
  branch text,
  last_pushed_at timestamptz,
  last_pushed_commit text,
  last_sync_at timestamptz,
  last_pulled_commit text,
  last_checked_at timestamptz,
  file_count integer not null default 0,
  storage_path text
);
create index if not exists projects_user_id_idx on public.projects(user_id);

create table if not exists public.snapshots (
  id uuid primary key,
  project_id uuid not null references public.projects(id) on delete cascade,
  user_id text not null references public.users(id) on delete cascade,
  label text not null,
  created_at timestamptz not null default now(),
  storage_path text not null,
  content_hash text not null
);
create index if not exists snapshots_project_id_created_at_idx on public.snapshots(project_id, created_at desc);
create index if not exists snapshots_user_id_idx on public.snapshots(user_id);

-- Server-owned tables are deliberately not exposed to anonymous/authenticated browser clients.
-- The backend uses the Supabase service-role key, which bypasses table RLS.
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.oauth_attempts enable row level security;
alter table public.login_codes enable row level security;
alter table public.sse_tickets enable row level security;
alter table public.projects enable row level security;
alter table public.snapshots enable row level security;

-- Private object bucket for project archives and snapshots.
insert into storage.buckets (id, name, public, file_size_limit)
values ('gpp-private', 'gpp-private', false, 52428800)
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit;

alter table storage.objects enable row level security;
