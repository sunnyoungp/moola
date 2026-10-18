// ============================================================================
// Moola — POST /functions/v1/transactions-ingest
// ============================================================================
// Transaction ingest endpoint for financial-data providers / aggregators.
//
// This is a Supabase Edge Function (Deno). Moola has no other server tier: the
// app is a static single-page HTML client that talks to Supabase directly, and
// each user's entire state is stored as ONE JSON blob in `user_data.data`
// (keyed by user_id). Transactions live at `data.transactions` (see
// index.html -> S.transactions). This function is the server-side entry point a
// provider uses to push transactions into a specific user's blob.
//
// SECURITY — the user is resolved from the credential, NEVER from the body:
//   * Caller presents a per-user bearer token: `Authorization: Bearer <token>`.
//   * We SHA-256-hash the presented token and look it up in `ingest_tokens`
//     (token_hash -> user_id). No match, or a revoked row -> 401, nothing
//     written.
//   * Any `userId` / `user_id` in the request body is IGNORED. A token for
//     user A can only ever read or write user A's row.
//   * Tokens are never logged. We never log the Authorization header or the
//     token value anywhere.
//
// UPSERT SEMANTICS (per acceptance criteria):
//   * Key is (user_id, transaction.id). The function only touches the
//     authenticated user's single row, so cross-user writes are impossible.
//   * New id  -> insert.
//   * Existing id -> update ONLY provider-owned fields (amount, date, merchant,
//     account, accountMask, currency, pending, direction, and provider-set
//     category when the user has not overridden it). It NEVER overwrites the
//     user's own edits: myShare, ignored, notes, and a user-chosen category.
//   * Idempotent: re-posting the same batch produces 0 inserts / updates-in-
//     place / 0 duplicates.
//
// VALIDATION:
//   * Each item must have id, date, merchant, amount. Invalid items are
//     collected; the response is 400 listing their indexes, but all VALID
//     items in the same batch are still processed and persisted.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Provider-owned fields: these are overwritten on update because the provider
// is the source of truth for them. Everything else on a stored transaction is
// considered user-owned and is preserved across ingests.
const PROVIDER_FIELDS = [
  "date",
  "merchant",
  "amount",
  "currency",
  "account",
  "accountMask",
  "pending",
] as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Extract the raw bearer token, or null. Never logged. */
function readBearer(req: Request): string | null {
  const h = req.headers.get("Authorization") || req.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1].trim() : "";
  return token.length ? token : null;
}

interface IncomingTx {
  id?: unknown;
  date?: unknown;
  merchant?: unknown;
  amount?: unknown;
  currency?: unknown;
  account?: unknown;
  accountMask?: unknown;
  category?: unknown;
  pending?: unknown;
}

/** Returns a list of reasons an item is invalid (empty => valid). */
function validate(tx: IncomingTx): string[] {
  const bad: string[] = [];
  if (typeof tx.id !== "string" || tx.id.trim() === "") bad.push("id");
  if (typeof tx.date !== "string" || !DATE_RE.test(tx.date)) bad.push("date");
  if (typeof tx.merchant !== "string" || tx.merchant.trim() === "") {
    bad.push("merchant");
  }
  if (typeof tx.amount !== "number" || !Number.isFinite(tx.amount)) {
    bad.push("amount");
  }
  return bad;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // --- 1. Resolve the user from the credential (never from the body). ------
  const raw = readBearer(req);
  if (!raw) return json({ error: "missing or invalid token" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const tokenHash = await sha256Hex(raw);
  const { data: tokenRow, error: tokenErr } = await admin
    .from("ingest_tokens")
    .select("user_id, revoked_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (tokenErr) {
    // Do not leak internals; the token itself is never included.
    return json({ error: "auth lookup failed" }, 500);
  }
  if (!tokenRow || tokenRow.revoked_at !== null) {
    return json({ error: "invalid or revoked token" }, 401);
  }
  const userId: string = tokenRow.user_id;

  // --- 2. Parse body. ------------------------------------------------------
  let body: { transactions?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body || !Array.isArray(body.transactions)) {
    return json({ error: "body.transactions must be an array" }, 400);
  }
  const incoming = body.transactions as IncomingTx[];

  // --- 3. Validate; collect bad indexes but keep going with the valid ones.-
  const invalid: { index: number; missing: string[] }[] = [];
  const valid: { index: number; tx: IncomingTx }[] = [];
  incoming.forEach((tx, index) => {
    const missing = validate(tx || {});
    if (missing.length) invalid.push({ index, missing });
    else valid.push({ index, tx });
  });

  // --- 4. Load ONLY this user's blob. --------------------------------------
  const { data: row, error: loadErr } = await admin
    .from("user_data")
    .select("data")
    .eq("user_id", userId)
    .maybeSingle();

  if (loadErr) return json({ error: "failed to load user data" }, 500);

  const blob: Record<string, unknown> = (row?.data as Record<string, unknown>) ??
    {};
  const existing: any[] = Array.isArray(blob.transactions)
    ? (blob.transactions as any[])
    : [];
  const byId = new Map<string, any>();
  for (const t of existing) byId.set(String(t.id), t);

  // --- 5. Upsert valid items by (user_id, id). -----------------------------
  let inserted = 0;
  let updated = 0;
  for (const { tx } of valid) {
    const id = String(tx.id);
    const prior = byId.get(id);

    if (!prior) {
      // INSERT — shape matches the client's S.transactions model.
      const amount = tx.amount as number;
      const record: Record<string, unknown> = {
        id,
        date: tx.date,
        merchant: tx.merchant,
        amount,
        currency: typeof tx.currency === "string" ? tx.currency : "USD",
        account: typeof tx.account === "string" ? tx.account : "",
        // positive amount = outflow (expense); negative = inflow (income)
        direction: amount < 0 ? "income" : "expense",
        // provider may suggest a category; user can override later
        category: typeof tx.category === "string" ? tx.category : "Uncategorized",
        pending: tx.pending === true,
        notes: "",
        // user-owned fields start empty so the client model is complete
        myShare: null,
        ignored: false,
        isRecurring: false,
        source: "ingest",
      };
      if (typeof tx.accountMask === "string") {
        record.accountMask = tx.accountMask;
      }
      byId.set(id, record);
      inserted++;
    } else {
      // UPDATE — provider fields only. NEVER touch user edits.
      const next = { ...prior };
      if (typeof tx.date === "string") next.date = tx.date;
      if (typeof tx.merchant === "string") next.merchant = tx.merchant;
      if (typeof tx.amount === "number") {
        next.amount = tx.amount;
        next.direction = tx.amount < 0 ? "income" : "expense";
      }
      if (typeof tx.currency === "string") next.currency = tx.currency;
      if (typeof tx.account === "string") next.account = tx.account;
      if (typeof tx.accountMask === "string") next.accountMask = tx.accountMask;
      if (typeof tx.pending === "boolean") next.pending = tx.pending;

      // Provider category only fills a blank/unset category; it must not
      // clobber a user-chosen category. We treat a category as user-owned once
      // it differs from the provider default.
      if (
        typeof tx.category === "string" &&
        (prior.category == null ||
          prior.category === "" ||
          prior.category === "Uncategorized")
      ) {
        next.category = tx.category;
      }

      // Explicitly preserve user-owned fields (defensive; spread already keeps
      // them, but this documents the contract and guards against bad priors).
      next.myShare = prior.myShare ?? null;
      next.ignored = prior.ignored === true;
      next.notes = typeof prior.notes === "string" ? prior.notes : "";
      if ("category" in prior && !("category" in next)) {
        next.category = prior.category;
      }

      byId.set(id, next);
      updated++;
    }
  }

  const skipped = invalid.length;

  // --- 6. Persist only if something valid changed. -------------------------
  if (valid.length > 0) {
    const nextTransactions = Array.from(byId.values());
    const nextBlob = { ...blob, transactions: nextTransactions };

    // Preserve the client's one-version backup convention.
    const { error: saveErr } = await admin.from("user_data").upsert(
      {
        user_id: userId,
        data: nextBlob,
        previous_data: row?.data ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (saveErr) return json({ error: "failed to persist" }, 500);
  }

  const payload = { inserted, updated, skipped };
  // 400 when any item was invalid, but valid items were still processed.
  if (invalid.length > 0) {
    return json({ ...payload, invalid }, 400);
  }
  return json(payload, 200);
});
