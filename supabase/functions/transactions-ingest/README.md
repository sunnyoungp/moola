# Transaction ingest endpoint

`POST /functions/v1/transactions-ingest`

Lets a financial-data provider / aggregator push transactions into a specific
Moola user's account. Moola is a static single-page app backed by Supabase, so
this Supabase Edge Function is the server-side entry point for provider writes.

## Why an Edge Function (and not `/api/...`)

Moola has no application server. The browser talks to Supabase directly, and
each user's entire state is one JSON blob in `user_data.data` (transactions
live at `data.transactions`, matching the client's `S.transactions`). An Edge
Function is Moola's only place to run trusted server code that holds the
service-role key, resolves the user from a credential, and enforces isolation.
The public path is therefore `/functions/v1/transactions-ingest` rather than
`/api/transactions/ingest` — that is this stack's API convention.

## Auth — per-user bearer tokens

```
Authorization: Bearer <token>
```

- The **user is resolved from the token**, never from the request body. Any
  `userId` in the body is ignored.
- The presented token is SHA-256-hashed and looked up in `ingest_tokens`
  (`token_hash → user_id`). No match, or a row with a non-null `revoked_at`,
  returns **401 with nothing written**.
- Raw tokens are **never stored** (only the hash) and **never logged**.
- A token for user A can only read/write user A's `user_data` row. There is no
  code path that reads another user's row, so user A's token cannot touch user
  B's transactions.

## Request body

```jsonc
{
  "transactions": [
    {
      "id": "prov_abc123",          // string, provider-unique (required)
      "date": "2026-10-18",          // YYYY-MM-DD (required)
      "merchant": "Blue Bottle",     // string (required)
      "amount": 7.85,                // number; + = outflow, − = inflow (required)
      "currency": "USD",
      "account": "Chase Checking",
      "accountMask": "1234",         // optional
      "category": "Dining",          // optional (provider suggestion only)
      "pending": false               // optional
    }
  ]
}
```

## Response

```json
{ "inserted": 1, "updated": 0, "skipped": 0 }
```

- Upsert is keyed by `(user_id, id)`: new `id` → insert; existing `id` → update
  **provider fields only** (`amount`, `date`, `merchant`, `account`,
  `accountMask`, `currency`, `pending`). Re-posting the same batch produces zero
  duplicates.
- Updates **never** overwrite the user's own edits: `myShare`, `ignored`,
  `notes`, and a user-chosen `category` are always preserved. A provider
  `category` only fills a blank/`Uncategorized` category.
- If any item is missing `id` / `date` / `merchant` / `amount`, the response is
  **400** and includes an `invalid` array listing the bad indexes and missing
  fields — but every **valid** item in the batch is still processed and saved.

## Deploy

```bash
supabase db push                              # applies the ingest_tokens migration
supabase functions deploy transactions-ingest # deploys this function
```

The function reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the
Edge runtime environment (both are injected by Supabase automatically).

## Minting a token

**Preferred (UI):** Settings → *Transaction Sync Token* → **Generate token**.
The raw token is shown exactly once; copy it immediately. Regenerating revokes
the old token.

**v1 SQL fallback** (mint the first token for a user, run as the *service role*
e.g. in the SQL editor). This returns the raw token once; store only what the
provider needs:

```sql
-- Mint a token for a given user. Revokes any existing active token first.
with revoked as (
  update public.ingest_tokens
     set revoked_at = now()
   where user_id = '<USER_UUID>' and revoked_at is null
   returning 1
),
minted as (
  select 'moola_' || encode(gen_random_bytes(32), 'hex') as raw
)
insert into public.ingest_tokens (token_hash, user_id)
select public.ingest_hash_token(raw), '<USER_UUID>' from minted
returning
  (select raw from minted) as raw_token_copy_now,
  user_id, created_at;
```

> The `raw_token_copy_now` value is the only time you'll see the raw token.
> Only its SHA-256 hash is persisted.

## Verifying the acceptance criteria

Replace `BASE`, `TOKEN_A`, `TOKEN_B` accordingly.

```bash
BASE="https://<project-ref>.supabase.co/functions/v1/transactions-ingest"

# AC1 — same batch twice => zero duplicates (2nd call returns updated=2, inserted=0)
BATCH='{"transactions":[
  {"id":"p_1","date":"2026-10-01","merchant":"Blue Bottle","amount":7.85,"account":"Chase"},
  {"id":"p_2","date":"2026-10-02","merchant":"Uber","amount":24.16,"account":"Chase"}]}'
curl -s -XPOST "$BASE" -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' -d "$BATCH"
curl -s -XPOST "$BASE" -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' -d "$BATCH"

# AC2 — pending then posted with corrected amount; user edits (category/myShare) preserved.
# 1) ingest pending; 2) in the UI set category + "my share"; 3) ingest the corrected/posted version:
curl -s -XPOST "$BASE" -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d '{"transactions":[{"id":"p_9","date":"2026-10-05","merchant":"The Progress","amount":300,"account":"Chase","pending":true}]}'
curl -s -XPOST "$BASE" -H "Authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d '{"transactions":[{"id":"p_9","date":"2026-10-06","merchant":"The Progress","amount":286.40,"account":"Chase","pending":false,"category":"Food"}]}'
#   -> amount/pending update; user's category + myShare remain.

# AC3 — wrong / missing / revoked token => 401, nothing written.
curl -s -o /dev/null -w "%{http_code}\n" -XPOST "$BASE" -d "$BATCH"                                   # missing  -> 401
curl -s -o /dev/null -w "%{http_code}\n" -XPOST "$BASE" -H "Authorization: Bearer nope" -d "$BATCH"   # wrong    -> 401
# (revoke in the UI, then re-run with the old token)                                                  # revoked  -> 401

# AC4 — User A's token cannot touch User B's data. Posting id "p_1" with TOKEN_B
# writes only to user B's row; user A's "p_1" is unaffected, and vice versa.
curl -s -XPOST "$BASE" -H "Authorization: Bearer $TOKEN_B" -H 'content-type: application/json' \
  -d '{"transactions":[{"id":"p_1","date":"2026-10-01","merchant":"B-only","amount":99,"account":"Wells"}]}'
#   -> inserted into user B's row only.
```

A pure-logic test of the validation + upsert/merge rules (AC1, AC2, validation)
lives in `_logic_test.mjs`: `node _logic_test.mjs`.
