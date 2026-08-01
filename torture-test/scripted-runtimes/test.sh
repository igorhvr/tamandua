#!/usr/bin/env bash
# test.sh — self-tests for the pi and hermes scripted runtimes.
#
# Invokes both runtimes directly (no daemon, no tamandua state) to verify
# normal behavior and every fault knob. Uses a mock tamandua CLI to satisfy
# the step peek/claim/complete protocol without a live daemon.
#
# Must pass twice consecutively (idempotent — each run uses fresh temp dirs).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_PI="$SCRIPT_DIR/runtime-pi.mjs"
RUNTIME_HERMES="$SCRIPT_DIR/runtime-hermes.mjs"
NODE_BIN="${TT_NODE_BIN:-$(command -v node)}"

PASS=0
FAIL=0

# --- helpers ---

red()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*" >&2; }

pass() { green "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { red "  FAIL: $1 — $2"; FAIL=$((FAIL + 1)); }

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    pass "$label"
  else
    fail "$label" "expected '$expected' got '$actual'"
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF "$needle" <<<"$haystack" 2>/dev/null; then
    pass "$label"
  else
    fail "$label" "expected output to contain '$needle'"
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF "$needle" <<<"$haystack" 2>/dev/null; then
    fail "$label" "output should NOT contain '$needle'"
  else
    pass "$label"
  fi
}

assert_ge() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" -ge "$expected" ]; then
    pass "$label"
  else
    fail "$label" "expected >= $expected, got $actual"
  fi
}

uuid_regex='[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}'

# ── Mock tamandua CLI ─────────────────────────────────────────────

create_mock_cli() {
  local tmp_dir="$1" cli_path="$tmp_dir/bin/tamandua"
  mkdir -p "$(dirname "$cli_path")"
  cat > "$cli_path" <<'MOCKEOF'
#!/usr/bin/env bash
# Mock tamandua CLI — responds to step peek/claim/complete/fail.
case "${1:-}" in
  step)
    case "${2:-}" in
      peek)   echo "HAS_WORK" ;;
      claim)  echo '{"stepId":"step-00000000-0000-0000-0000-000000000001","runId":"run-a1c557f2-ba6e-4088-ae59-0d8892ce6e32","input":"TEST_TASK: test\n"}' ;;
      complete|fail) : ;;  # accept piped input, exit 0
      *) echo "MOCK: unknown step subcommand: $2" >&2; exit 1 ;;
    esac
    ;;
  peek) echo "HAS_WORK" ;;
  *)    echo "MOCK: unknown command: $1" >&2; exit 1 ;;
esac
MOCKEOF
  chmod +x "$cli_path"
  echo "$cli_path"
}

# ── Behaviors file ─────────────────────────────────────────────────

create_behaviors_file() {
  local path="$1"; shift
  local json="$1"
  printf '{"agents":%s,"heartbeatTokens":17,"defaultTokens":111}\n' "$json" > "$path"
}

# ── Prompt builder ─────────────────────────────────────────────────

build_prompt() {
  local cli_path="$1"
  cat <<PROMPT
You are agent "developer" for workflow "test-wf", agent "test-wf_developer", run "run-a1c557f2-ba6e-4088-ae59-0d8892ce6e32".

CLAIM:
"$cli_path" step claim "test-wf_developer" --run-id "a1c557f2-ba6e-4088-ae59-0d8892ce6e32"
PROMPT
}

# ── UUID check helper ──────────────────────────────────────────────

is_valid_uuid() {
  echo "$1" | grep -q "^[0-9a-f]\{8\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{4\}-[0-9a-f]\{12\}$"
}

# ── Runtime invocation helpers ────────────────────────────────────
# Run the pi runtime with a given behaviors file and prompt.
# Returns combined stdout+stderr (via 2>&1) and exit code as the
# last line (EXIT:<code>).
run_pi() {
  local tmp_dir="$1" behaviors_path="$2" prompt_file="$3" state_dir="$4"
  TAMANDUA_SCRIPTED_STATE="$state_dir" \
    TAMANDUA_SCRIPTED_BEHAVIORS="$behaviors_path" \
    PATH="$tmp_dir/bin:$PATH" \
    "$NODE_BIN" "$RUNTIME_PI" --dummy-flag "$(cat "$prompt_file")" \
    2>&1 </dev/null
}

# Run the hermes runtime with a given behaviors file and prompt.
# Returns combined stdout+stderr (via 2>&1) and exit code as the
# last line (EXIT:<code>).
run_hermes() {
  local tmp_dir="$1" behaviors_path="$2" prompt_file="$3" state_dir="$4" hermes_home="$5"
  HERMES_HOME="$hermes_home" \
    TAMANDUA_SCRIPTED_STATE="$state_dir" \
    TAMANDUA_SCRIPTED_BEHAVIORS="$behaviors_path" \
    PATH="$tmp_dir/bin:$PATH" \
    "$NODE_BIN" "$RUNTIME_HERMES" chat --max-turns 8192 --yolo -Q -q "$(cat "$prompt_file")" \
    2>&1 </dev/null
}

# Extract exit code from the last EXIT: line and strip it from output.
parse_output() {
  local raw="$1" outvar="$2" codevar="$3"
  local _code _stdout
  _code="$(echo "$raw" | grep '^EXIT:' | tail -1 | sed 's/EXIT://')"
  _stdout="$(echo "$raw" | sed '/^EXIT:/d')"
  printf -v "$outvar" '%s' "$_stdout"
  printf -v "$codevar" '%s' "$_code"
}

# ═══════════════════════════════════════════════════════════════════
# PI Runtime Tests
# ═══════════════════════════════════════════════════════════════════

test_pi_normal_done() {
  echo "=== PI: normal done round ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-pi-normal.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  mkdir -p "$state_dir"

  create_behaviors_file "$behaviors_path" '{"test-wf_developer":{"output":"STATUS: done"}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_pi "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir"; printf '\nEXIT:%s\n' "$?")" || true
  parse_output "$raw" stdout exit_code

  assert_eq "pi normal exit code" "0" "$exit_code"
  assert_contains "pi normal has STATUS: done" "$stdout" "STATUS: done"
  assert_contains "pi normal has message_end" "$stdout" '"type":"message_end"'
}

test_pi_retry() {
  echo "=== PI: STATUS: retry round ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-pi-retry.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  mkdir -p "$state_dir"

  create_behaviors_file "$behaviors_path" '{"test-wf_developer":{"output":"STATUS: retry"}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_pi "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir"; printf '\nEXIT:%s\n' "$?")" || true
  parse_output "$raw" stdout exit_code

  assert_eq "pi retry exit code" "0" "$exit_code"
  assert_contains "pi retry has STATUS: retry" "$stdout" "STATUS: retry"
}

test_pi_delayed_trailer() {
  echo "=== PI: delayed_trailer_ms ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-pi-delay.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  mkdir -p "$state_dir"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"output":"STATUS: done","delayed_trailer_ms":500}}'
  build_prompt "$cli_path" > "$prompt_file"

  local start_ns end_ns duration_ms
  start_ns="$(date +%s%N)"
  local raw exit_code stdout
  raw="$(run_pi "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir"; printf '\nEXIT:%s\n' "$?")" || true
  end_ns="$(date +%s%N)"
  parse_output "$raw" stdout exit_code
  duration_ms=$(( (end_ns - start_ns) / 1000000 ))

  assert_eq "pi delayed exit code" "0" "$exit_code"
  assert_ge "pi delayed duration >= 400ms" "400" "$duration_ms"
  assert_contains "pi delayed has message_end" "$stdout" '"type":"message_end"'
}

test_pi_omit_trailer() {
  echo "=== PI: omit_trailer ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-pi-omit.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  mkdir -p "$state_dir"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"output":"STATUS: done","omit_trailer":true}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_pi "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir"; printf '\nEXIT:%s\n' "$?")" || true
  parse_output "$raw" stdout exit_code

  assert_eq "pi omit exit code" "0" "$exit_code"
  assert_not_contains "pi omit no message_end" "$stdout" '"type":"message_end"'
}

test_pi_malformed_trailer() {
  echo "=== PI: malformed_trailer ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-pi-malform.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  mkdir -p "$state_dir"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"output":"STATUS: done","malformed_trailer":true}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_pi "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir"; printf '\nEXIT:%s\n' "$?")" || true
  parse_output "$raw" stdout exit_code

  assert_eq "pi malformed exit code" "0" "$exit_code"

  # Find the message_end line and verify JSON.parse fails
  local msg_end_line
  msg_end_line="$(grep 'message_end' <<<"$stdout" || true)"
  if [ -z "$msg_end_line" ]; then
    fail "pi malformed has message_end" "no message_end line found"
  elif ! "$NODE_BIN" -e "
    let data='';
    process.stdin.on('data',c=>data+=c);
    process.stdin.on('end',()=>{
      try { JSON.parse(data.trim()); process.exit(0); }
      catch(e) { process.exit(1); }
    })" <<<"$msg_end_line" 2>/dev/null; then
    pass "pi malformed JSON.parse throws"
  else
    fail "pi malformed JSON.parse should throw" "JSON.parse succeeded on malformed output"
  fi
}

test_pi_oversized_stdout() {
  echo "=== PI: oversized_stdout_mb ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-pi-oversize.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  mkdir -p "$state_dir"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"output":"STATUS: done","oversized_stdout_mb":0.25}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout byte_count
  raw="$(run_pi "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir"; printf '\nEXIT:%s\n' "$?")" || true
  parse_output "$raw" stdout exit_code
  byte_count="${#stdout}"

  local min_bytes=$(( (250 * 1024 * 1024) / 1000 ))  # 0.25 MB in bytes (approx)
  assert_eq "pi oversized exit code" "0" "$exit_code"
  assert_ge "pi oversized byte count >= 250000" "250000" "$byte_count"
  assert_contains "pi oversized has padding" "$stdout" "# padding"
  assert_contains "pi oversized has STATUS: done after padding" "$stdout" "STATUS: done"
}

test_pi_provider_error_429() {
  echo "=== PI: provider_error 429 ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-pi-429.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  mkdir -p "$state_dir"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"provider_error":{"shape":"429"}}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_pi "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir"; printf '\nEXIT:%s\n' "$?")" || true
  parse_output "$raw" stdout exit_code

  if [ "$exit_code" != "0" ]; then pass "pi 429 non-zero exit"; else fail "pi 429 non-zero exit" "expected non-zero, got 0"; fi
  assert_contains "pi 429 has error type" "$stdout" '"type":"error"'
  assert_contains "pi 429 has code 429" "$stdout" '429'
  assert_not_contains "pi 429 no step claim" "$stdout" '"type":"tool_execution_end"'
}

test_pi_provider_error_529() {
  echo "=== PI: provider_error 529 ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-pi-529.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  mkdir -p "$state_dir"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"provider_error":{"shape":"529"}}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_pi "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir"; printf '\nEXIT:%s\n' "$?")" || true
  parse_output "$raw" stdout exit_code

  if [ "$exit_code" != "0" ]; then pass "pi 529 non-zero exit"; else fail "pi 529 non-zero exit" "expected non-zero, got 0"; fi
  assert_contains "pi 529 has error type" "$stdout" '"type":"error"'
  assert_contains "pi 529 has code 529" "$stdout" '529'
}

test_pi_provider_error_mid_stream_drop() {
  echo "=== PI: provider_error mid-stream-drop ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-pi-drop.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  mkdir -p "$state_dir"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"provider_error":{"shape":"mid-stream-drop"}}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_pi "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir"; printf '\nEXIT:%s\n' "$?")" || true
  parse_output "$raw" stdout exit_code

  if [ "$exit_code" != "0" ]; then pass "pi drop non-zero exit"; else fail "pi drop non-zero exit" "expected non-zero, got 0"; fi
  # Output should be partial/truncated — not valid JSON
  if ! "$NODE_BIN" -e "
    let data='';
    process.stdin.on('data',c=>data+=c);
    process.stdin.on('end',()=>{
      try { JSON.parse(data.trim()); process.exit(0); }
      catch(e) { process.exit(1); }
    })" <<<"$stdout" 2>/dev/null; then
    pass "pi drop output truncated (not valid JSON)"
  else
    fail "pi drop output should be truncated" "full valid JSON detected"
  fi
  # Note: mid-stream-drop intentionally outputs a partial tool_execution_end
  # as the truncated content — this is expected behavior, not a real step claim.
}

# ═══════════════════════════════════════════════════════════════════
# Hermes Runtime Tests
# ═══════════════════════════════════════════════════════════════════

test_hermes_normal_done() {
  echo "=== HERMES: normal done round ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-hermes-normal.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir hermes_home
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  hermes_home="$tmp_dir/hermes_home"
  mkdir -p "$state_dir" "$hermes_home"

  create_behaviors_file "$behaviors_path" '{"test-wf_developer":{"output":"STATUS: done"}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout session_id
  raw="$(run_hermes "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir" "$hermes_home"; printf '\nEXIT:%s\n' "$?")" || true
  parse_output "$raw" stdout exit_code

  assert_eq "hermes normal exit code" "0" "$exit_code"
  assert_contains "hermes normal has STATUS: done" "$stdout" "STATUS: done"

  # session_id is on stderr (but stderr is merged into stdout by 2>&1 above)
  # Extract session_id from the merged output
  session_id="$(grep <<<"$stdout" '^session_id: ' | sed 's/^session_id: //' | head -1)"
  if [ -n "$session_id" ] && is_valid_uuid "$session_id"; then
    pass "hermes normal valid session_id UUID"
  else
    fail "hermes normal valid session_id UUID" "got '${session_id:-<none>}'"
  fi

  # Verify state.db row exists
  if "$NODE_BIN" -e "
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync('$hermes_home/state.db');
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get('$session_id');
    db.close();
    if (!row) process.exit(1);
  " 2>/dev/null; then
    pass "hermes normal state.db row exists"
  else
    fail "hermes normal state.db row" "no row for session $session_id"
  fi
}

test_hermes_retry() {
  echo "=== HERMES: STATUS: retry round ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-hermes-retry.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir hermes_home
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  hermes_home="$tmp_dir/hermes_home"
  mkdir -p "$state_dir" "$hermes_home"

  create_behaviors_file "$behaviors_path" '{"test-wf_developer":{"output":"STATUS: retry"}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_hermes "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir" "$hermes_home"; printf '\nEXIT:%s\n' "$?")" || true

  parse_output "$raw" stdout exit_code

  assert_eq "hermes retry exit code" "0" "$exit_code"
  assert_contains "hermes retry has STATUS: retry" "$stdout" "STATUS: retry"
}

test_hermes_delayed_trailer() {
  echo "=== HERMES: delayed_trailer_ms ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-hermes-delay.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir hermes_home
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  hermes_home="$tmp_dir/hermes_home"
  mkdir -p "$state_dir" "$hermes_home"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"output":"STATUS: done","delayed_trailer_ms":500}}'
  build_prompt "$cli_path" > "$prompt_file"

  local start_ns end_ns duration_ms
  start_ns="$(date +%s%N)"
  local raw exit_code stdout session_id
  raw="$(run_hermes "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir" "$hermes_home"; printf '\nEXIT:%s\n' "$?")" || true

  end_ns="$(date +%s%N)"
  parse_output "$raw" stdout exit_code

  duration_ms=$(( (end_ns - start_ns) / 1000000 ))

  assert_eq "hermes delayed exit code" "0" "$exit_code"
  assert_ge "hermes delayed duration >= 400ms" "400" "$duration_ms"

  session_id="$(grep <<<"$stdout" '^session_id: ' | sed 's/^session_id: //' | head -1)"
  if [ -n "$session_id" ] && is_valid_uuid "$session_id"; then
    pass "hermes delayed valid session_id UUID"
  else
    fail "hermes delayed valid session_id UUID" "got '${session_id:-<none>}'"
  fi
}

test_hermes_omit_trailer() {
  echo "=== HERMES: omit_trailer ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-hermes-omit.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir hermes_home
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  hermes_home="$tmp_dir/hermes_home"
  mkdir -p "$state_dir" "$hermes_home"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"output":"STATUS: done","omit_trailer":true}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_hermes "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir" "$hermes_home"; printf '\nEXIT:%s\n' "$?")" || true

  parse_output "$raw" stdout exit_code

  assert_eq "hermes omit exit code" "0" "$exit_code"
  assert_not_contains "hermes omit no session_id" "$stdout" "session_id:"
  # Verify no state.db or no rows in it
  if [ ! -f "$hermes_home/state.db" ]; then
    pass "hermes omit no state.db"
  else
    local row_count
    row_count="$("$NODE_BIN" -e "
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync('$hermes_home/state.db');
      const rows = db.prepare('SELECT COUNT(*) as c FROM sessions').all();
      db.close();
      console.log(rows[0]?.c ?? 0);
    " 2>/dev/null || echo "0")"
    if [ "${row_count:-0}" = "0" ]; then
      pass "hermes omit no state.db rows"
    else
      fail "hermes omit no state.db rows" "found $row_count rows"
    fi
  fi
}

test_hermes_malformed_trailer() {
  echo "=== HERMES: malformed_trailer ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-hermes-malform.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir hermes_home
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  hermes_home="$tmp_dir/hermes_home"
  mkdir -p "$state_dir" "$hermes_home"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"output":"STATUS: done","malformed_trailer":true}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_hermes "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir" "$hermes_home"; printf '\nEXIT:%s\n' "$?")" || true

  parse_output "$raw" stdout exit_code

  assert_eq "hermes malformed exit code" "0" "$exit_code"
  assert_contains "hermes malformed has STATUS: done" "$stdout" "STATUS: done"
  # Session ID line should be NOT-A-UUID, not a valid UUID
  local sess_line
  sess_line="$(grep <<<"$stdout" '^session_id: ' || true)"
  if echo "$sess_line" | grep -q 'NOT-A-UUID'; then
    pass "hermes malformed session_id is NOT-A-UUID"
  elif echo "$sess_line" | grep -q "$uuid_regex"; then
    fail "hermes malformed session_id NOT valid UUID" "got valid UUID instead of NOT-A-UUID"
  else
    fail "hermes malformed session_id" "unexpected: $sess_line"
  fi
}

test_hermes_oversized_stdout() {
  echo "=== HERMES: oversized_stdout_mb ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-hermes-oversize.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir hermes_home
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  hermes_home="$tmp_dir/hermes_home"
  mkdir -p "$state_dir" "$hermes_home"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"output":"STATUS: done","oversized_stdout_mb":0.25}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout byte_count
  raw="$(run_hermes "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir" "$hermes_home"; printf '\nEXIT:%s\n' "$?")" || true

  parse_output "$raw" stdout exit_code
  byte_count="${#stdout}"

  assert_eq "hermes oversized exit code" "0" "$exit_code"
  assert_ge "hermes oversized byte count >= 250000" "250000" "$byte_count"
  assert_contains "hermes oversized has padding" "$stdout" "# padding"
  assert_contains "hermes oversized has STATUS: done after padding" "$stdout" "STATUS: done"
}

test_hermes_provider_error_429() {
  echo "=== HERMES: provider_error 429 ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-hermes-429.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir hermes_home
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  hermes_home="$tmp_dir/hermes_home"
  mkdir -p "$state_dir" "$hermes_home"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"provider_error":{"shape":"429"}}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_hermes "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir" "$hermes_home"; printf '\nEXIT:%s\n' "$?")" || true

  parse_output "$raw" stdout exit_code

  if [ "$exit_code" != "0" ]; then pass "hermes 429 non-zero exit"; else fail "hermes 429 non-zero exit" "expected non-zero, got 0"; fi
  assert_contains "hermes 429 has error text" "$stdout" "Rate limit exceeded"
  assert_contains "hermes 429 has code" "$stdout" "429"

  # No state.db should exist
  if [ ! -f "$hermes_home/state.db" ]; then
    pass "hermes 429 no state.db"
  else
    fail "hermes 429 no state.db" "state.db exists but shouldn't"
  fi
}

test_hermes_provider_error_529() {
  echo "=== HERMES: provider_error 529 ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-hermes-529.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir hermes_home
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  hermes_home="$tmp_dir/hermes_home"
  mkdir -p "$state_dir" "$hermes_home"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"provider_error":{"shape":"529"}}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_hermes "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir" "$hermes_home"; printf '\nEXIT:%s\n' "$?")" || true

  parse_output "$raw" stdout exit_code

  if [ "$exit_code" != "0" ]; then pass "hermes 529 non-zero exit"; else fail "hermes 529 non-zero exit" "expected non-zero, got 0"; fi
  assert_contains "hermes 529 has error text" "$stdout" "overloaded"
  assert_contains "hermes 529 has code" "$stdout" "529"
}

test_hermes_provider_error_mid_stream_drop() {
  echo "=== HERMES: provider_error mid-stream-drop ==="
  local tmp_dir
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/tt-test-hermes-drop.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' RETURN

  local cli_path behaviors_path prompt_file state_dir hermes_home
  cli_path="$(create_mock_cli "$tmp_dir")"
  behaviors_path="$tmp_dir/behaviors.json"
  prompt_file="$tmp_dir/prompt.txt"
  state_dir="$tmp_dir/state"
  hermes_home="$tmp_dir/hermes_home"
  mkdir -p "$state_dir" "$hermes_home"

  create_behaviors_file "$behaviors_path" \
    '{"test-wf_developer":{"provider_error":{"shape":"mid-stream-drop"}}}'
  build_prompt "$cli_path" > "$prompt_file"

  local raw exit_code stdout
  raw="$(run_hermes "$tmp_dir" "$behaviors_path" "$prompt_file" "$state_dir" "$hermes_home"; printf '\nEXIT:%s\n' "$?")" || true

  parse_output "$raw" stdout exit_code

  if [ "$exit_code" != "0" ]; then pass "hermes drop non-zero exit"; else fail "hermes drop non-zero exit" "expected non-zero, got 0"; fi
  # Output should be partial "STATUS: d"
  if grep -q '^STATUS: d' <<<"$stdout"; then
    pass "hermes drop truncated output"
  else
    fail "hermes drop truncated output" "expected 'STATUS: d' prefix"
  fi
}

# ═══════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════

echo "=== test.sh — scripted runtime self-tests ==="
echo ""

# PI tests
test_pi_normal_done
test_pi_retry
test_pi_delayed_trailer
test_pi_omit_trailer
test_pi_malformed_trailer
test_pi_oversized_stdout
test_pi_provider_error_429
test_pi_provider_error_529
test_pi_provider_error_mid_stream_drop

# Hermes tests
test_hermes_normal_done
test_hermes_retry
test_hermes_delayed_trailer
test_hermes_omit_trailer
test_hermes_malformed_trailer
test_hermes_oversized_stdout
test_hermes_provider_error_429
test_hermes_provider_error_529
test_hermes_provider_error_mid_stream_drop

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
