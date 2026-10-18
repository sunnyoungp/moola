-- ============================================================================
-- Moola transaction-ingest: per-user bearer tokens
-- ============================================================================
-- This migration adds the `ingest_tokens` table used by the
-- `transactions-ingest` Edge Function to resolve a user from a presented
-- bearer token.
--
-- SECURITY MODEL
--   * We NEVER store the raw token. Only its SHA-256 hash (hex) is persisted.
--   * We NEVER return the raw token from the database. The raw token only
--     exists for the brief moment it is minted (returned once to the caller).
--   * Lookups are by (token_hash -> user_id). A row with a non-null
--     `revoked_at` is treated as invalid.
--   * The table is NOT exposed to the browser via RLS reads of the hash;
--     clients only interact through the SECURITY DEFINER RPCs below, which
--     operate strictly on `auth.uid()` (the logged-in user) and never trust a
--     user id supplied by the caller.
-- ============================================================================

create extension if not exists "pgcrypto";

create table if not exists public.ingest_tokens (
  token_hash  text        primary key,
  user_id     uuid        not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- One active (non-revoked) token per user at a time. Regenerating revokes the
-- old row, so this partial unique index guarantees at most one live token.
create unique index if not exists ingest_tokens_one_active_per_user
  on public.ingest_tokens (user_id)
  where revoked_at is null;

create index if not exists ingest_tokens_user_id_idx
  on public.ingest_tokens (user_id);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------
-- The browser (anon/authenticated role) gets NO direct table access. Token
-- hashes must never be readable or writable from the client; all legitimate
-- client operations go through the SECURITY DEFINER functions below. The Edge
-- Function uses the service-role key, which bypasses RLS.
alter table public.ingest_tokens enable row level security;
revoke all on public.ingest_tokens from anon, authenticated;

-- ----------------------------------------------------------------------------
-- Helper: hash a raw token the same way the Edge Function does (SHA-256 hex).
-- ----------------------------------------------------------------------------
create or replace function public.ingest_hash_token(raw text)
returns text
language sql
immutable
as $$
  select encode(digest(raw, 'sha256'), 'hex');
$$;

-- ----------------------------------------------------------------------------
-- RPC: mint / regenerate the current user's ingest token.
-- ----------------------------------------------------------------------------
-- Revokes any existing active token for the caller, mints a fresh one, stores
-- only its hash, and returns the RAW token exactly once. The raw token is
-- never persisted and cannot be retrieved again. Resolves the user from
-- auth.uid() only -- never from any argument.
create or replace function public.ingest_regenerate_token()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  uid       uuid := auth.uid();
  raw_token text;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;

  -- Revoke every currently-active token for this user.
  update public.ingest_tokens
     set revoked_at = now()
   where user_id = uid
     and revoked_at is null;

  -- Mint a new opaque token: "moola_" + 32 random bytes, base64url-ish hex.
  raw_token := 'moola_' || encode(gen_random_bytes(32), 'hex');

  insert into public.ingest_tokens (token_hash, user_id)
  values (public.ingest_hash_token(raw_token), uid);

  return raw_token;
end;
$$;

revoke all on function public.ingest_regenerate_token() from public, anon;
grant execute on function public.ingest_regenerate_token() to authenticated;

-- ----------------------------------------------------------------------------
-- RPC: report whether the current user has an active token + when it was made.
-- ----------------------------------------------------------------------------
-- Returns metadata ONLY (never the raw token or the hash) so the Settings UI
-- can show "token active since <date>" with a regenerate button.
create or replace function public.ingest_token_status()
returns table (has_token boolean, created_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select
    exists (
      select 1 from public.ingest_tokens
      where user_id = auth.uid() and revoked_at is null
    ) as has_token,
    (
      select t.created_at from public.ingest_tokens t
      where t.user_id = auth.uid() and t.revoked_at is null
      order by t.created_at desc
      limit 1
    ) as created_at;
$$;

revoke all on function public.ingest_token_status() from public, anon;
grant execute on function public.ingest_token_status() to authenticated;

-- ----------------------------------------------------------------------------
-- RPC: revoke the current user's active token(s) without minting a new one.
-- ----------------------------------------------------------------------------
create or replace function public.ingest_revoke_token()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  update public.ingest_tokens
     set revoked_at = now()
   where user_id = auth.uid()
     and revoked_at is null;
end;
$$;

revoke all on function public.ingest_revoke_token() from public, anon;
grant execute on function public.ingest_revoke_token() to authenticated;
