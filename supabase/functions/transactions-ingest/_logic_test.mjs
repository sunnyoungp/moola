// Pure-logic test for the ingest endpoint's validation + upsert/merge rules.
// Mirrors the logic in index.ts so we can exercise the acceptance criteria in
// Node (the Deno runtime isn't available in this sandbox). Run: node _logic_test.mjs
import assert from "node:assert";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(tx) {
  const bad = [];
  if (typeof tx.id !== "string" || tx.id.trim() === "") bad.push("id");
  if (typeof tx.date !== "string" || !DATE_RE.test(tx.date)) bad.push("date");
  if (typeof tx.merchant !== "string" || tx.merchant.trim() === "") bad.push("merchant");
  if (typeof tx.amount !== "number" || !Number.isFinite(tx.amount)) bad.push("amount");
  return bad;
}

// Processes a batch against an existing transactions array for ONE user.
// Returns { transactions, inserted, updated, skipped, invalid }.
function ingest(existing, incoming) {
  const invalid = [];
  const valid = [];
  incoming.forEach((tx, index) => {
    const missing = validate(tx || {});
    if (missing.length) invalid.push({ index, missing });
    else valid.push(tx);
  });

  const byId = new Map(existing.map((t) => [String(t.id), t]));
  let inserted = 0, updated = 0;

  for (const tx of valid) {
    const id = String(tx.id);
    const prior = byId.get(id);
    if (!prior) {
      const amount = tx.amount;
      const record = {
        id, date: tx.date, merchant: tx.merchant, amount,
        currency: typeof tx.currency === "string" ? tx.currency : "USD",
        account: typeof tx.account === "string" ? tx.account : "",
        direction: amount < 0 ? "income" : "expense",
        category: typeof tx.category === "string" ? tx.category : "Uncategorized",
        pending: tx.pending === true,
        notes: "", myShare: null, ignored: false, isRecurring: false, source: "ingest",
      };
      if (typeof tx.accountMask === "string") record.accountMask = tx.accountMask;
      byId.set(id, record);
      inserted++;
    } else {
      const next = { ...prior };
      if (typeof tx.date === "string") next.date = tx.date;
      if (typeof tx.merchant === "string") next.merchant = tx.merchant;
      if (typeof tx.amount === "number") { next.amount = tx.amount; next.direction = tx.amount < 0 ? "income" : "expense"; }
      if (typeof tx.currency === "string") next.currency = tx.currency;
      if (typeof tx.account === "string") next.account = tx.account;
      if (typeof tx.accountMask === "string") next.accountMask = tx.accountMask;
      if (typeof tx.pending === "boolean") next.pending = tx.pending;
      if (typeof tx.category === "string" &&
          (prior.category == null || prior.category === "" || prior.category === "Uncategorized")) {
        next.category = tx.category;
      }
      next.myShare = prior.myShare ?? null;
      next.ignored = prior.ignored === true;
      next.notes = typeof prior.notes === "string" ? prior.notes : "";
      byId.set(id, next);
      updated++;
    }
  }
  return { transactions: Array.from(byId.values()), inserted, updated, skipped: invalid.length, invalid };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ✓", name); }

console.log("Acceptance criteria:");

// AC1: POSTing the same batch twice creates zero duplicates.
test("same batch twice => 0 duplicates", () => {
  const batch = [
    { id: "p_1", date: "2026-10-01", merchant: "Blue Bottle", amount: 7.85, account: "Chase" },
    { id: "p_2", date: "2026-10-02", merchant: "Uber", amount: 24.16, account: "Chase" },
  ];
  const first = ingest([], batch);
  assert.strictEqual(first.inserted, 2);
  assert.strictEqual(first.updated, 0);
  const second = ingest(first.transactions, batch);
  assert.strictEqual(second.inserted, 0);
  assert.strictEqual(second.updated, 2);        // updated in place
  assert.strictEqual(second.transactions.length, 2); // no duplicates
});

// AC2: a pending tx that later posts with corrected amount updates in place,
// keeping the user's category/adjustment edits.
test("pending->posted updates provider fields, preserves user edits", () => {
  const seeded = ingest([], [
    { id: "p_9", date: "2026-10-05", merchant: "The Progress", amount: 300, account: "Chase", pending: true, category: "Uncategorized" },
  ]);
  // User edits: picks a category, sets myShare, adds a note.
  const t = seeded.transactions[0];
  t.category = "Dining";
  t.myShare = 64;
  t.ignored = true;
  t.notes = "birthday dinner";

  const after = ingest(seeded.transactions, [
    { id: "p_9", date: "2026-10-06", merchant: "The Progress", amount: 286.40, account: "Chase", pending: false, category: "Food" },
  ]);
  const u = after.transactions[0];
  assert.strictEqual(after.updated, 1);
  assert.strictEqual(after.transactions.length, 1);
  // provider fields corrected:
  assert.strictEqual(u.amount, 286.40);
  assert.strictEqual(u.pending, false);
  assert.strictEqual(u.date, "2026-10-06");
  // user edits preserved:
  assert.strictEqual(u.category, "Dining");   // provider "Food" must NOT win
  assert.strictEqual(u.myShare, 64);
  assert.strictEqual(u.ignored, true);
  assert.strictEqual(u.notes, "birthday dinner");
});

// AC (validation): 400 lists bad indexes but still processes valid ones.
test("invalid items reported by index, valid ones still processed", () => {
  const r = ingest([], [
    { id: "ok_1", date: "2026-10-01", merchant: "A", amount: 10 }, // valid
    { id: "", date: "2026-10-01", merchant: "B", amount: 5 },       // bad id
    { id: "ok_2", date: "bad", merchant: "C", amount: 5 },           // bad date
    { id: "ok_3", date: "2026-10-01", merchant: "", amount: 5 },     // bad merchant
    { id: "ok_4", date: "2026-10-01", merchant: "D" },               // missing amount
    { id: "ok_5", date: "2026-10-02", merchant: "E", amount: -40 },  // valid inflow
  ]);
  assert.strictEqual(r.inserted, 2);  // ok_1, ok_5
  assert.strictEqual(r.skipped, 4);
  assert.deepStrictEqual(r.invalid.map((x) => x.index), [1, 2, 3, 4]);
  assert.deepStrictEqual(r.invalid[0].missing, ["id"]);
  assert.deepStrictEqual(r.invalid[4 - 1]?.missing, ["amount"]);
  // sign convention: negative => inflow/income
  assert.strictEqual(r.transactions.find((t) => t.id === "ok_5").direction, "income");
  assert.strictEqual(r.transactions.find((t) => t.id === "ok_1").direction, "expense");
});

// User-chosen category is preserved; provider category only fills blanks.
test("provider category fills only blank/Uncategorized", () => {
  const seeded = ingest([], [{ id: "c1", date: "2026-10-01", merchant: "X", amount: 9 }]);
  assert.strictEqual(seeded.transactions[0].category, "Uncategorized");
  // provider supplies a category on next ingest -> fills the blank
  const filled = ingest(seeded.transactions, [{ id: "c1", date: "2026-10-01", merchant: "X", amount: 9, category: "Shopping" }]);
  assert.strictEqual(filled.transactions[0].category, "Shopping");
  // user overrides, provider tries to change it -> user wins
  filled.transactions[0].category = "Gifts";
  const kept = ingest(filled.transactions, [{ id: "c1", date: "2026-10-01", merchant: "X", amount: 9, category: "Shopping" }]);
  assert.strictEqual(kept.transactions[0].category, "Gifts");
});

console.log(`\nAll ${passed} tests passed.`);
console.log("\nNote: user-isolation (AC4) and 401 behavior (AC3) are enforced by");
console.log("token_hash->user_id resolution + the service-role single-row load in");
console.log("index.ts; they are integration concerns, not part of this pure merge logic.");
