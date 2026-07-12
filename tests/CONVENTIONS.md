# Testing Conventions — Anti-Race Rules

This document codifies testing conventions to prevent a specific defect class: **test races from shared mutable state** in concurrent execution contexts. Following these rules eliminates intermittent failures where a sibling test perturbs a test's expectations by mutating shared state.

These rules complement [MOTOR-CONTRACT.md](./MOTOR-CONTRACT.md), which defines the behavioral invariants for Tamandua's deterministic dispatch motor. The motor contract focuses on _what_ the motor guarantees; this document focuses on _how_ to write tests that survive concurrent execution without flaking.

---

## Rule 1 — Scope Assertions

**In any shared-store concurrent context, scope assertions to the test's own rows — never assert on global counts.**

`node:test` runs subtests concurrently by default within a describe block. If multiple subtests share a database (SQLite, in-memory store, etc.), an assertion like `COUNT(*) FROM runs` or `result.recovered === 0` is a data race — a sibling test can insert or mutate rows between the operation and the assertion.

### How to Fix

```typescript
// ❌ Wrong — races with any sibling that inserts a run
const count = db.prepare("SELECT COUNT(*) FROM runs").get().count;
assert.equal(count, 1);

// ✅ Correct — scoped to the test's own row
const myRunId = crypto.randomUUID();
// ... seed with myRunId ...
const count = db.prepare(
  "SELECT COUNT(*) FROM runs WHERE id = ?"
).get(myRunId);
assert.equal(count, 1);
```

### Sentinel Run Pattern

When verifying that an operation _creates no new rows_ (e.g., a flaky endpoint should not create runs), seed a known sentinel row before the operation, then assert the count is unchanged:

```typescript
// Seed a sentinel
const sentinelId = crypto.randomUUID();
seedRun(sentinelId);
const beforeCount = db.prepare("SELECT COUNT(*) FROM runs").get().count;

// Perform the operation
await flakyEndpoint();

// Assert sentinel count is unchanged AND sentinel still exists
const afterCount = db.prepare("SELECT COUNT(*) FROM runs").get().count;
assert.equal(afterCount, beforeCount);
const sentinel = db.prepare("SELECT COUNT(*) FROM runs WHERE id = ?").get(sentinelId);
assert.equal(sentinel.count, 1);
```

This avoids the empty-table dependency (`assert.equal(count, 0)`) that a concurrent sibling can break.

### Silently-Safe Contexts

A bare `COUNT(*)` is safe only when:
- The test creates a fresh, isolated DB/store in its own `beforeEach` (not shared with any other test)
- The file runs in the serial lane (`tests/serial-files.txt`) and has no concurrent subtests within the file

Even in these cases, document the assumption with a comment so future refactors don't unknowingly break it:
```typescript
// SAFE: per-test createTempHome() in beforeEach + serial lane = no concurrent siblings
```

---

## Rule 2 — Unique IDs

**Use `crypto.randomUUID()` or per-test unique prefixes wherever a store is shared across tests.**

Hardcoded identifiers (`"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"`, `"test-run-1"`, fixed hex strings) create collision risk. Even if a test file creates an isolated environment today, a future refactor that shares a `createTempHome()` call across subtests would turn those shared IDs into race conditions indistinguishable from logic bugs.

### How to Fix

```typescript
// ❌ Wrong — collision-prone
const runId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const anotherId = "test-run-1";

// ✅ Correct — unique per execution
const runId = crypto.randomUUID();
const anotherId = crypto.randomUUID();

// ✅ Also correct — unique prefixes for scoped SQL assertions
const myPrefix = "us008-my-test";
// Query: WHERE tree_hash LIKE 'us008-my-test%'
```

For non-UUID identifiers (git SHAs, hex hashes):
```typescript
const sha = crypto.randomBytes(8).toString("hex"); // 16-char hex
```

When replacing hardcoded IDs used in assertions, update regex matches to use the generated value:
```typescript
// ❌ Assertion on hardcoded prefix
assert.match(stdout, /Run: aaaaaaaa/);

// ✅ Assertion on generated prefix
assert.match(stdout, new RegExp(`Run: ${runId.substring(0, 8)}`));
```

---

## Rule 3 — No Serialize-As-Fix

**Don't add sleeps or serialize tests to fix races. Fix the isolation instead.**

Adding `await sleep(100)`, `{ concurrency: 1 }`, or moving a file to `tests/serial-files.txt` hides the race — it doesn't fix the root cause. Tests that should be correct concurrently become fragile serial bottlenecks, and the underlying isolation defect persists for the next person who relaxes concurrency.

### The Serial-File Escape Hatch

Moving a file to `tests/serial-files.txt` is allowed **only** when the test genuinely requires process-global exclusivity:
- The test creates daemon processes that bind fixed ports
- The test modifies OS-level state (e.g., git worktrees on the same repo)
- The test manipulates a process-global singleton that cannot be isolated (document why)

Even then, use serial placement as a permanent classification, not a hotfix. If you're adding a file to serial-files.txt _because_ a test flakes, that's a sign the test needs isolation, not serialization.

### When `concurrency: 1` IS Correct

`{ concurrency: 1 }` on a `describe` block is the right fix when subtests share state through `process.env` and a module-level singleton (like `getDb()`). `getDb()` resolves `process.env.TAMANDUA_DB_PATH` at call time — if concurrent `beforeEach` hooks race on setting the env var, the singleton can serve the wrong DB. In this case, serialization within the describe block is the correct mitigation because the shared state is process-global and cannot be isolated per-test.

Always document the reason:
```typescript
// concurrency: 1 required because subtests share process.env.TAMANDUA_DB_PATH
// through getDb() singleton — can't isolate process.env per concurrent subtest
describe("myTest", { concurrency: 1 }, () => { ... });
```

---

## Case Study — WDGT (Dead Worker Recovery Race)

**File:** `tests/dead-worker-recovery.test.ts`  
**Symptom:** Two intermittent test failures in one week  
**Root cause:** Assertions on global aggregates in a shared-DB concurrent context

### What Happened

The dead-worker recovery test suite uses `seedStoryRun()` / `seedWatchdogStep()` helpers that insert rows into a shared SQLite database. Multiple describe blocks run subtests concurrently, all sharing the same DB. One test asserted:

```typescript
assert.equal(result.recovered, 0);
```

This assertion tracked a **global aggregate** — the number of steps recovered by the sweeper. While this test expected zero recoveries (no orphans), a concurrently-running sibling test's just-seeded step could be swept in the same sweeper call, making `result.recovered > 0` and failing the assertion.

### The Fix (commit 9deffe1)

The 5-second backdating window used by `seedStoryRun()` / `seedWatchdogStep()` was too tight — under concurrent load, setup latency could exceed 5 seconds, making a sibling's step appear "old enough" to be swept. The fix widened backdating to 30 seconds:

```typescript
// Before: 5s backdating — setup latency could exceed this under heavy load
seedStoryRun({ backdateSeconds: 5, ... });

// After: 30s backdating — safe margin for setup latency
seedStoryRun({ backdateSeconds: 30, ... });
```

But this fix was initially applied only to the **two tests that had already failed**. The full audit (US-001 through US-007) then systematically applied the same class of fix — scoping assertions, replacing hardcoded IDs, and widening time windows — across the entire test suite so no other test would fail the same way.

### Key Takeaway

**A concurrent sibling can perturb any test that relies on global state.** If you're writing a test and find yourself thinking "the other test won't run at the same time" or "this assertion is safe because the table should be empty," that's exactly where a race will appear. Scope it, prefix it, isolate it.

---

## References

- [MOTOR-CONTRACT.md](./MOTOR-CONTRACT.md) — Deterministic dispatch motor invariants (C0–C23)
- [AGENTS.md](../AGENTS.md) — Project-level development instructions
- `tests/serial-files.txt` — Files that run in the serial lane (process-global exclusivity)
- `tests/serial-files-integrity.test.ts` — Guard ensuring serial classification is correct
- `tests/test-isolation-guard.test.ts` — Guard preventing test leakage into the live Tamandua instance
