# SFX-A: campaign #8 controller/probe/daemon-control fixes — S17 replay gate, S18 probe engine, S24 PATH containment

From the campaign #8 attempt-3 adjudicated review (evidence:
torture-test/var/results/campaign-20260822T073029892Z-48c0215b-.../;
adjudication details in the operator's session synthesis — all root causes
below are mechanically verified, cite-checked file:line).

1. **S17 — replay gate reads a field that no longer exists.** The TSTX
   replay WORKED (suite-observations.json has the genuine cache-hit row,
   marker TAMANDUA-TEST CACHED) but W1.REPLAY-python/ts died
   replay-snapshot-missing because tt-controller:2124 overwrites
   oracle_evidence with completeOracleEvidenceSnapshot()'s return
   (oracle-evidence-snapshot.mjs:1193: {schema_version,status,references,
   provenance} — no ledger_path; the ledger ref moved to provenance.path),
   and the gate assessReplayCacheHit (tt-controller:3556) reads only
   .ledger_path → null. FIX GATE-SIDE ONLY (tt-controller): fall back to
   oracle_evidence.provenance.path — do NOT modify
   oracle-evidence-snapshot.mjs (a concurrent run owns it). ALSO fix the
   latent second bug before it bites: the gate filters
   row.run_id === attempt.run_id but snapshot rows carry bare UUIDs while
   attempt.run_id is run--prefixed — normalize both sides (existing
   canonical helpers). Red-then-green: reproduce the miss against the
   current gate with a captured fixture, then prove the replay case class
   passes.
2. **S18 — probe engine.** (a) executeProbeAction (~tt-controller:5270)
   must capture bounded stdout+stderr (say 8KB each) of probe action
   commands into the action record and its failure object — W3.19/W3.21
   diagnosis was delayed because the CLI's real refusal messages were
   discarded. (b) Add awaited triggers to the probe trigger vocabulary:
   await run status (e.g. {"when":{"status":"paused","timeout_s":N}}) and
   await event (e.g. run.process_cleanup), then update the W3.19 (resume
   after pause-drain must await paused) and W3.21 (resume after
   force_failed must await process cleanup/worker drain) probe sequences
   to use them. (c) probe-action-failed must terminate the case
   IMMEDIATELY: stop the underlying run and classify TEST_INFRA_FAIL at
   failure time — W3.19 burned ~178 dead minutes and ~59k runaway tokens
   riding its wall cap after the probe had already failed.
3. **S24 — daemon-control restart drops the adapters-bin PATH invariant
   (containment leak).** daemon-control relaunches with env -i ...
   PATH="${PATH}" (lines ~185/801/804), losing tt-daemon-up's
   var/adapters-bin prepend; after W3.22's restart probe, the contained
   daemon resolved the OPERATOR'S ~/.local/bin/pi-token-saver (foreign
   binary executed inside the contained run — this is the W3.23 root
   cause). Fix: daemon-control start/restart must reconstruct the
   contained PATH invariant itself (adapters-bin first; operator
   ~/.local/bin must NOT precede contained dirs for the contained kinds),
   and the controller must re-assert the tt-daemon-up PATH invariant
   after any restart_daemon probe action. Add a token-saver-case
   preflight: assert pi-token-saver resolves inside var/adapters-bin
   before a flagged launch. Red-then-green for the PATH reconstruction
   (simulate a restart, assert resolution). Do NOT touch the
   --no-hurry-please-save-tokens-mode flag or its plumbing.

Prove: targeted red-then-green tests for each; full self-test battery
green from repo root; bare ./run-torture-test --tier1 GREEN in a quiet
window (53xx free — wait if busy).

## Hard constraints
- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. Concurrent runs own torture-test/oracles/** and
  torture-test/bin/oracle-evidence-snapshot.mjs (SFX-B) and src/**
  (TATR) — touch NONE of those; tt-controller, daemon-control,
  tt-daemon-up, probe/scenario manifests are yours.
