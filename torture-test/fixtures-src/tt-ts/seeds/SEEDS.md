# Seeds Documentation — tt-ts fixture

## Defect Archetypes

| Archetype | Description |
|-----------|-------------|
| A1 | Off-by-one error: loop boundary condition off by one, missing the last element |
| A2 | Two-module bug: coordinated defect across server and store requiring multi-file fix |
| A3 | Red-herring bug: visible symptom suggests frontend issue, root cause is in the store |
| A4 | Performance bug: O(n²) algorithm passes small-dataset tests, degrades on large input |

## Seed Catalog

### BUG-T1: Off-by-one in category filter (Archetype A1)

- **Seed patch:** `seeds/BUG-T1.patch`
- **Fix patch:** `seeds/fix/BUG-T1-fix.patch`
- **Difficulty:** Easy
- **Affected files:** `src/store.ts`
- **Bug:** `getByCategory` uses a manual `for` loop with condition `i < this.#expenses.length - 1`, skipping the last element of the internal array. When the last expense in the array matches the queried category, it is excluded from results.
- **Dormancy:** The existing test suite uses small datasets where the last element is a non-matching category, so the bug is never triggered.
- **Expected symptom:** Filtering by category returns fewer expenses than expected when the category has multiple entries and the last matching entry is at the end of the array.
- **Regression test (in fix patch):** Creates 3 Food expenses with a Transport expense interspersed (Food, Food, Transport, Food) so the last element is a matching Food — the off-by-one causes `getByCategory('Food')` to return 2 instead of 3.

### BUG-T2: Two-module date handling (Archetype A2)

- **Seed patch:** `seeds/BUG-T2.patch`
- **Fix patch:** `seeds/fix/BUG-T2-fix.patch`
- **Difficulty:** Medium
- **Affected files:** `src/server.ts`, `src/store.ts`
- **Bug:** `server.ts` parses user-provided dates from POST body using `new Date(dateStr).toISOString()`, which produces full ISO datetime strings with timezone offsets (e.g., `2025-06-15T15:00:00.000Z` in UTC-3). Meanwhile, `store.ts` `getByDateRange` uses naive string comparison (`localeCompare`) to filter by date range. When a full ISO string like `2025-06-15T15:00:00.000Z` is compared against a YYYY-MM-DD query like `"2025-06-15"`, the `T` character sorts after end-of-string, causing the expense to be excluded from exact-date queries.
- **Dormancy:** The existing test suite never submits a `date` field in POST body and never uses `?startDate=`/`?endDate=` query params, so the bug code path is present but untriggered.
- **Expected symptom:** Date-based filtering returns inconsistent results — expenses near day boundaries are missing from query results. Example: POST an expense with `date: "2025-06-15"`, then GET `/api/expenses?startDate=2025-06-15&endDate=2025-06-15` — the expense is not found.
- **Fix:** `server.ts` normalizes dates to UTC midnight YYYY-MM-DD format (`new Date(cleanDate + 'T00:00:00Z').toISOString().split('T')[0]`). `store.ts` replaces string comparison with UTC timestamp comparison (`new Date(date).getTime()`) that correctly handles mixed date formats.
- **Regression test (in fix patch):** Store test verifies `getByDateRange` correctly includes expenses with timezone-offset ISO dates. Server tests verify POST normalizes dates to YYYY-MM-DD, date range query params filter correctly, and combined category+date filtering works.

### BUG-T3: Red-herring ordering bug (Archetype A3)

- **Seed patch:** `seeds/BUG-T3.patch`
- **Fix patch:** `seeds/fix/BUG-T3-fix.patch`
- **Difficulty:** Medium
- **Affected files:** `src/store.ts`
- **Bug:** `update()` splices the existing expense out of its position and pushes the updated copy to the end of the internal array, instead of replacing in-place. This corrupts the array order so `getAll()` returns expenses in a different order after any `update()` call — the updated expense jumps to the end of the list.
- **Dormancy:** The existing test suite never asserts ordering of `getAll()` results after `update()`. All CRUD correctness tests (getById, getByCategory, getTotal, etc.) pass because they don't depend on element position.
- **Expected symptom:** After editing an expense in the UI, the edited item moves to the end of the expense list. The visible symptom (items reordering/jumping after edit) naturally suggests a frontend rendering or DOM manipulation bug in `app.js`, but the root cause is in `store.ts update()`. The displayed total is computed correctly from the full expense list — the red herring is that the ordering corruption looks like a frontend bug.
- **Regression test (in fix patch):** Creates 3 expenses, updates the middle one, asserts `getAll()` preserves the original order `[e1, e2-updated, e3]` — with BUG-T3, the order becomes `[e1, e3, e2-updated]`.

### BUG-T4: Performance degradation (Archetype A4)

- **Seed patch:** `seeds/BUG-T4.patch`
- **Fix patch:** `seeds/fix/BUG-T4-fix.patch`
- **Difficulty:** Medium
- **Affected files:** `src/store.ts`
- **Bug:** `getByCategory` replaces the O(n) `Array.filter()` call with an O(n²) implementation that uses nested loops with `JSON.stringify` comparisons. For each expense, the inner loop serializes every other expense ID and category pair and compares against the current target — producing ~4M `JSON.stringify` calls for 2,000 expenses.
- **Dormancy:** The existing test suite uses datasets of 1–5 expenses per test, where the O(n²) overhead is imperceptible (~0.1ms). No existing test asserts on execution time or uses large datasets.
- **Expected symptom:** Category filtering becomes dramatically slow with large datasets. With 2,000 expenses, `getByCategory` takes ~180ms instead of the expected sub-millisecond O(n) time — a ~300x slowdown.
- **Regression test (in fix patch):** Creates 2,000 expenses distributed evenly across 5 categories (400 per category), calls `getByCategory('Food')`, and asserts completion in under 50ms. With the O(n) fix this takes < 1ms; with the O(n²) bug it takes ~180ms and fails the threshold assertion.

### VULN-T1: XSS via unescaped description (Dormant in baseline)

- **No seed patch:** Vulnerability is present in the green baseline code.
- **Fix patch:** `seeds/fix/VULN-T1-fix.patch`
- **Difficulty:** Easy
- **Affected files:** `public/app.js`
- **Bug:** In `renderRow()`, expense descriptions are rendered via `descTd.innerHTML = expense.description;` instead of `descTd.textContent = expense.description;`. If a description field contains HTML or `<script>` tags (e.g., `<img src=x onerror=alert(1)>`), the script executes in the user's browser context.
- **Dormancy:** No existing test sends HTML/script tags in description fields — the vulnerable code path (innerHTML rendering) is present in every row render but the malicious input never occurs, so all 59 baseline tests pass.
- **Expected symptom:** A description containing `<img src=x onerror=...>` triggers script execution when the expense list renders.
- **Fix:** Replace `descTd.innerHTML` with `descTd.textContent` in `renderRow()`. This ensures descriptions are always rendered as plain text, regardless of content.

### VULN-T2: Prototype pollution (Dormant in baseline)

- **No seed patch:** Vulnerability is present in the green baseline code.
- **Fix patch:** `seeds/fix/VULN-T2-fix.patch`
- **Difficulty:** Easy
- **Affected files:** `src/server.ts`
- **Bug:** The PUT `/api/expenses/:id` handler merges request body properties into a new object using `Object.assign({}, body as Record<string, unknown>)` without filtering dangerous keys. An attacker can send `{"__proto__": {"isAdmin": true}}` or `{"constructor": {"prototype": {"polluted": true}}}` to pollute `Object.prototype`, affecting all objects created in the server process.
- **Dormancy:** No existing test sends `__proto__`, `constructor`, or `prototype` keys in the request body — the vulnerable `Object.assign` code path runs on every PUT request but the malicious keys never appear, so all 59 baseline tests pass.
- **Expected symptom:** After a PUT request with `__proto__` payload, `({}).polluted` evaluates to `true` — all newly created objects inherit the polluted property.
- **Fix:** Replace `Object.assign` with a safe property copy loop that skips `__proto__`, `constructor`, and `prototype` keys.

### BRK-T1: Broken store test assertion

- **Seed patch:** `seeds/BRK-T1.patch`
- **Fix patch:** `seeds/fix/BRK-T1-fix.patch`
- **Difficulty:** Easy
- **Affected files:** `src/store.test.ts`
- **Bug:** The test "returns sum of all expense amounts" in the `getTotal` describe block asserts `store.getTotal()` equals `150` instead of the correct value `60` (10 + 20 + 30 = 60). The assertion genuinely fails on every execution.
- **Determinism:** This is a purely deterministic static assertion failure — the expected value is hardcoded wrong, and the actual value is always `60` for the given test data (three expenses with amounts 10, 20, 30). No environmental or timing dependency.
- **Expected symptom:** Test runner reports: `Expected values to be strictly equal: 60 !== 150`. One test fails (the getTotal sum test), 58 tests pass.
- **Fix:** Restore the correct expected value `60` in the `assert.strictEqual` call.

### BRK-T2: Broken server test assertion

- **Seed patch:** `seeds/BRK-T2.patch`
- **Fix patch:** `seeds/fix/BRK-T2-fix.patch`
- **Difficulty:** Easy
- **Affected files:** `src/server.test.ts`
- **Bug:** The test "creates an expense and returns 201 with the created object" in the `POST /api/expenses` describe block asserts `status` equals `200` instead of the correct value `201`. The server correctly returns HTTP 201 Created for a successful POST, but the assertion expects 200 (OK). The assertion genuinely fails on every execution.
- **Determinism:** This is a purely deterministic static assertion failure — the expected status code is hardcoded wrong, and the server always returns 201 for a successful POST with valid data. No environmental or timing dependency.
- **Expected symptom:** Test runner reports: `Expected values to be strictly equal: 201 !== 200`. One test fails (the POST 201 test), 58 tests pass.
- **Fix:** Restore the correct expected status `201` in the `assert.strictEqual` call.
