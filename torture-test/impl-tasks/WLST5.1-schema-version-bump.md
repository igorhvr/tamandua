# WLST5.1: WLST5's ceiling_expiry_count migration never runs on existing DBs — SCHEMA_VERSION not bumped

WLST5 (5873a9a9, merged via staging 70b8bab7) added a correct guarded
migration in src/db.ts (~line 253: pragma_table_info check + ALTER TABLE
runs ADD COLUMN ceiling_expiry_count) but did NOT bump SCHEMA_VERSION.
migrate() early-returns when user_version === SCHEMA_VERSION (src/db.ts
~line 64), so EVERY existing DB skips the new migration: both the
production ~/.tamandua/tamandua.db and the torture contained DB lack the
column today; only brand-new DBs (full DDL path) have it. The file header
says exactly this: "Any change to migrate() MUST bump SCHEMA_VERSION.
Missing a bump causes broken DBs." Consequence in the wild: any SQL that
references the column crashes on existing installs — this killed torture
campaign #8 twice (tt-controller SELECT -> "no such column:
ceiling_expiry_count" -> monitor crash).

1. Bump SCHEMA_VERSION so migrate() runs its body on existing DBs. Audit
   that ALL migration steps in migrate() are idempotent when re-run
   (guarded ALTERs / CREATE IF NOT EXISTS) — they appear to be, but
   verify each; the bump causes a full-body re-run on every existing DB.
2. Add the upgrade-path regression test this defect proves is missing:
   construct a DB with the PREVIOUS user_version and a runs table lacking
   ceiling_expiry_count (simulating a pre-WLST5 install), call the db
   open/migrate path, assert the column now exists and user_version is
   current. Generalize if cheap: assert every column present in a
   fresh-DDL DB is also present in a migrated legacy DB (schema parity
   fresh-vs-upgraded) — that guard catches this whole defect class
   forever.
3. Report: state plainly why WLST5's own verifier+tester missed it (fresh
   DBs in tests take the full-DDL path; no upgrade-path coverage existed).

## Hard constraints

- Product code (src/, tests/) only — no torture-test/ changes.
- Do not restart or reconfigure the LIVE daemon (33xx); the operator
  handles install/restart after merge.
- Keep the diff minimal: the bump, the audit notes, the regression test.
