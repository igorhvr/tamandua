#!/usr/bin/env bash
# =============================================================================
# MTLK-INTERACTIVE-SUITE — tier-aware, fail-closed receipt validator.
#
#   validate-receipts.sh <evdir> <expected-image-digest>
#
# Prints exactly one final line:
#
#   VALIDATION-OK <evdir>            (exit 0)
#   VALIDATION-FAIL <reason;...>     (exit 1)
#
# It decides from EVIDENCE FILES ONLY. It never greps a human log for a "PASS"
# marker word to conclude success: a case's verdict is read from its
# `case-summary.json`, the requested scope is read from the recorded manifest,
# and the M7 outcome is read from the bound verdict file. Marker FILES
# (`HALTED`, `WAVE-FAILED`, `MATRIX-PHASE-DONE`) are checked for presence, but a
# marker alone can never make a missing/failed case pass.
#
# Checks (every one fail-closed; a missing/unreadable item is a failure):
#   1. identity lines: `<evdir>/identity.txt` exists and its `expect_digest`
#      equals the expected digest, with a non-empty `tamandua_sha256`, a
#      `mode` of candidate|installed and a non-empty `matchlock_bin`.
#   2. the recorded manifest `<evdir>/manifest/requested.tsv` exists and is
#      well formed (`lib/manifest.sh` format).
#   3. every REQUESTED REQUIRED tier is PASS; every requested optional tier is
#      either PASS or an explicitly declared NOTRUN (never still pending).
#      A requested PASS tier with no requested case rows fails
#      (`tier-no-cases`), except t4 whose evidence is the M7 spot-run.
#   4. every REQUESTED case's `case-summary.json` (at the manifest's recorded
#      evidence path) has `verdict == "PASS"` and an empty `unowned_new_vms`.
#      A requested required case still UNEXECUTED/RUNNING/NOTRUN fails.
#   5. no `HALTED` and no `WAVE-FAILED`; `MATRIX-PHASE-DONE` present in the
#      matrix log. A completion marker contradicting a failure marker fails.
#   6. when t4 is REQUESTED: the bound `M7/m7-verdict-path.txt` names a file
#      that literally contains `PASS`, and the M7 invocation log's last verdict
#      line is a PASS (a `FAIL log=` line fails, and a missing M7 log fails).
#
# Usage errors exit 2. Python 3 is a suite prerequisite (see lib/common.sh).
# =============================================================================
set -u

EV="${1:-}"
EXP="${2:-}"
if [ -z "$EV" ] || [ -z "$EXP" ]; then
  printf 'usage: validate-receipts.sh <evdir> <expected-digest>\n' >&2
  exit 2
fi

exec python3 - "$EV" "$EXP" <<'PY'
import json
import os
import sys

ev = os.path.abspath(sys.argv[1])
exp = sys.argv[2]
fails = []


def add(reason):
    fails.append(reason)


def read_text(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return None


# --- 1. identity ----------------------------------------------------------
ident_path = os.path.join(ev, "identity.txt")
if not os.path.isfile(ident_path):
    add("missing-identity")
else:
    text = read_text(ident_path)
    if text is None:
        add("unreadable-identity")
    else:
        idents = {}
        for line in text.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                idents[key.strip()] = value.strip()
        if idents.get("expect_digest") != exp:
            add("identity-digest")
        if not idents.get("tamandua_sha256"):
            add("identity-tamandua-sha")
        if idents.get("mode") not in ("candidate", "installed"):
            add("identity-mode")
        if not idents.get("matchlock_bin"):
            add("identity-matchlock")

# --- 2. recorded requested manifest --------------------------------------
rows = []
manifest = os.path.join(ev, "manifest", "requested.tsv")
if not os.path.isfile(manifest):
    add("missing-manifest")
else:
    text = read_text(manifest)
    if text is None:
        add("unreadable-manifest")
    else:
        for line in text.splitlines()[1:]:
            if not line.strip():
                continue
            parts = line.split("\t")
            if len(parts) < 7:
                add("malformed-manifest")
                continue
            rows.append(
                {
                    "kind": parts[0],
                    "tier": parts[1],
                    "name": parts[2],
                    "requested": parts[3],
                    "required": parts[4],
                    "evidence": parts[5],
                    "status": parts[6],
                }
            )

requested_tiers = [r for r in rows if r["kind"] == "tier" and r["requested"] == "1"]
requested_cases = [r for r in rows if r["kind"] == "case" and r["requested"] == "1"]

# --- 3. requested tiers ---------------------------------------------------
for tier in requested_tiers:
    tname = tier["tier"]
    if tier["required"] == "1" and tier["status"] != "PASS":
        add("tier-not-pass:%s" % tname)
    if tier["required"] == "0" and tier["status"] in ("UNEXECUTED", "RUNNING"):
        # A requested optional tier that did not run must be explicitly declared
        # NOTRUN by manifest finalization; a pending row is not a declaration.
        add("tier-not-declared:%s" % tname)
    tier_cases = [c for c in requested_cases if c["tier"] == tname]
    # A PASS tier (other than t4, whose evidence is the M7 spot-run) must be
    # backed by at least one requested case. This stops an empty tier from being
    # marked PASS without any case evidence.
    if tier["status"] == "PASS" and tname != "t4" and not tier_cases:
        add("tier-no-cases:%s" % tname)

# --- 4. requested case summaries -----------------------------------------
for case in requested_cases:
    name = case["name"]
    status = case["status"]
    if status != "PASS":
        add("case-not-pass:%s=%s" % (name, status))
        continue
    summary = os.path.join(ev, case["evidence"], "case-summary.json")
    if not os.path.isfile(summary):
        add("missing-case-summary:%s" % name)
        continue
    try:
        with open(summary, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        add("unreadable-case-summary:%s" % name)
        continue
    if data.get("verdict") != "PASS":
        add("case-verdict:%s=%s" % (name, data.get("verdict")))
        continue
    unowned = data.get("unowned_new_vms") or []
    if unowned:
        add("case-unowned:%s=%s" % (name, ",".join(str(v) for v in unowned)))

# --- 5. phase / contradiction markers ------------------------------------
halted = os.path.isfile(os.path.join(ev, "matrix", "HALTED")) or os.path.isfile(
    os.path.join(ev, "HALTED")
)
wave_failed = os.path.isfile(os.path.join(ev, "matrix", "WAVE-FAILED")) or os.path.isfile(
    os.path.join(ev, "WAVE-FAILED")
)
completed = os.path.isfile(os.path.join(ev, "matrix", "WAVE-COMPLETED")) or os.path.isfile(
    os.path.join(ev, "WAVE-COMPLETED")
)
if halted:
    add("halted-present")
if wave_failed:
    add("wave-failed-present")
if completed and (halted or wave_failed):
    add("contradictory-markers")

phase_done = False
for candidate in (
    os.path.join(ev, "matrix", "run-cases.log"),
    os.path.join(ev, "matrix", "wave-cases.log"),
    os.path.join(ev, "wave-cases.log"),
):
    if os.path.isfile(candidate):
        text = read_text(candidate)
        if text is not None and "MATRIX-PHASE-DONE" in text:
            phase_done = True
            break
if not phase_done:
    add("phase-done-missing")

# --- 6. M7 (only when t4 was requested) ----------------------------------
t4_requested = any(t["tier"] == "t4" and t["requested"] == "1" for t in requested_tiers)
if t4_requested:
    binding = os.path.join(ev, "M7", "m7-verdict-path.txt")
    if not os.path.isfile(binding):
        add("m7-binding-missing")
    else:
        first = ""
        binding_text = read_text(binding)
        if binding_text is not None:
            for line in binding_text.splitlines():
                if line.strip():
                    first = line.strip()
                    break
        if not first:
            add("m7-binding-missing")
        else:
            verdict_file = first
            if not os.path.isabs(verdict_file):
                verdict_file = os.path.join(ev, verdict_file)
            content = read_text(verdict_file) if os.path.isfile(verdict_file) else None
            if content is None or "".join(content.split()) != "PASS":
                add("m7-verdict-file")

    m7_log = next(
        (
            p
            for p in (
                os.path.join(ev, "M7", "m7.log"),
                os.path.join(ev, "matrix", "wave-m7.log"),
                os.path.join(ev, "wave-m7.log"),
            )
            if os.path.isfile(p)
        ),
        None,
    )
    if m7_log is None:
        add("m7-log-missing")
    else:
        log_text = read_text(m7_log) or ""
        verdict_lines = [
            line.strip()
            for line in log_text.splitlines()
            if line.strip().startswith("PASS ") or line.strip().startswith("FAIL ")
        ]
        if any(line.startswith("FAIL ") for line in verdict_lines):
            add("m7-fail-line")
        if not verdict_lines or not verdict_lines[-1].startswith("PASS "):
            add("m7-not-pass")

# --- verdict --------------------------------------------------------------
if fails:
    print("VALIDATION-FAIL %s" % ";".join(fails))
    sys.exit(1)
print("VALIDATION-OK %s" % ev)
sys.exit(0)
PY
