/**
 * MTLK-INTERACTIVE-SUITE US-003 — `lib/common.sh` configuration/identity contract.
 *
 * `scripts/tests/matchlock/lib/common.sh` is the one sourced configuration and
 * identity module every suite script uses. This file pins its documented
 * contract without booting a VM, touching the network, or building the repo:
 *
 *   - sourcing twice is a no-op (idempotent) and the documented `MTLK_*`
 *     bindings are defined;
 *   - the matchlock runtime pair resolves before any PATH/HOME change;
 *   - INSTALLED mode resolves `tamandua` from PATH and never runs a build;
 *   - CANDIDATE mode builds the worktree and binds `<repo>/dist/cli/cli.js`;
 *   - a missing required digest refuses with `MTLK-ABORT no-expected-digest`;
 *   - the capability probe fails closed (exit 3, exact
 *     `MTLK-CAPABILITY-UNAVAILABLE <reason>` line) when a prerequisite is
 *     missing and succeeds when the pair is usable;
 *   - T3 runs only when explicitly enabled AND credentials are present.
 *
 * This file spawns `bash` (node:child_process) and is therefore classified in
 * the serial lane; it is registered exactly once in tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const commonPath = path.join(repoRoot, "scripts", "tests", "matchlock", "lib", "common.sh");

/** The documented default bindings. */
const DEFAULT_ALLOW_PRIVATE = "ai.iasylum.net:8888";
const DEFAULT_GATE_LOCK = "/home/kaladin/matchlock-work/vaivm-gate.lock";

interface BashResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Single-quote a string for safe interpolation into a `bash -c` script. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run a bash program; the ambient environment is inherited. */
function runBash(script: string): BashResult {
  const result = spawnSync("bash", ["-c", script], {
    cwd: repoRoot,
    encoding: "utf-8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, `failed to spawn bash: ${result.error?.message ?? "unknown"}`);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Parse `key=value` lines into a map (first `=` splits). */
function lineMap(stdout: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf("=");
    if (idx > 0) map.set(line.slice(0, idx), line.slice(idx + 1));
  }
  return map;
}

function sha256File(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Write an executable stub script into `dir` and return its path. */
function writeStub(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, body, "utf-8");
  chmodSync(file, 0o755);
  return file;
}

/** Preamble that clears ambient MTLK_* state so each case is deterministic. */
const RESET = [
  "unset MTLK_COMMON_SOURCED MTLK_REPO_ROOT MTLK_SUITE_DIR MTLK_WORKDIR",
  "unset MTLK_ALLOW_PRIVATE MTLK_MODEL_ENDPOINT MTLK_EXPECT_DIGEST MTLK_BACKEND",
  "unset MTLK_MODE MTLK_GATE_LOCK MTLK_MATCHLOCK_RPC_BIN MTLK_GUEST_INIT",
  "unset MTLK_TAMANDUA_BIN MTLK_TAMANDUA_SHA MTLK_TAMANDUA_ARGV0 MTLK_BUILD_PROVENANCE",
  "unset MTLK_REQUIRE_KVM MTLK_KVM_DEVICE MTLK_REQUIRE_GUEST_INIT MTLK_SKIP_BUILD",
  "unset MTLK_T3_ENABLED MTLK_T3_CREDENTIAL_ENV",
  "unset MTLK_MODEL_API_KEY TAMANDUA_MODEL_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY",
].join("\n");

describe("Matchlock interactive lib/common.sh (MTLK-INTERACTIVE-SUITE US-003)", () => {
  it("ships lib/common.sh as a regular file", () => {
    assert.ok(existsSync(commonPath), `missing ${commonPath}`);
  });

  it("is idempotent when sourced twice and defines the documented MTLK_* bindings", () => {
    const script = [
      RESET,
      `source ${shQuote(commonPath)}`,
      'first="$(mtlk_identity_lines)"',
      `source ${shQuote(commonPath)}`,
      'second="$(mtlk_identity_lines)"',
      'if [ "$first" != "$second" ]; then echo "IDENTITY-DRIFT"; exit 9; fi',
      'printf "MTLK_IDEMPOTENT=ok\\n"',
      'printf "SOURCED=%s\\n" "$MTLK_COMMON_SOURCED"',
      'printf "REPO=%s\\n" "$MTLK_REPO_ROOT"',
      'printf "SUITE=%s\\n" "$MTLK_SUITE_DIR"',
      'printf "WORKDIR=%s\\n" "$MTLK_WORKDIR"',
      'printf "UID=%s\\n" "$MTLK_UID"',
      'printf "GID=%s\\n" "$MTLK_GID"',
      'printf "ALLOW=%s\\n" "$MTLK_ALLOW_PRIVATE"',
      'printf "ENDPOINT=%s\\n" "$MTLK_MODEL_ENDPOINT"',
      'printf "MODE=%s\\n" "$MTLK_MODE"',
      'printf "BACKEND=[%s]\\n" "$MTLK_BACKEND"',
      'printf "GATE=%s\\n" "$MTLK_GATE_LOCK"',
      'printf "TIMEOUT_BOOT=%s\\n" "$MTLK_TIMEOUT_BOOT"',
      'printf "TIMEOUT_CASE=%s\\n" "$MTLK_TIMEOUT_CASE"',
      'printf "TIMEOUT_T3=%s\\n" "$MTLK_TIMEOUT_T3"',
      'printf "TIMEOUT_T4=%s\\n" "$MTLK_TIMEOUT_T4"',
      'printf "T3_ENABLED=%s\\n" "$MTLK_T3_ENABLED"',
    ].join("\n");
    const result = runBash(script);
    assert.equal(result.status, 0, `bash failed: ${result.stdout}${result.stderr}`);

    const vars = lineMap(result.stdout);
    assert.equal(vars.get("MTLK_IDEMPOTENT"), "ok", "sourcing twice must not drift the identity");
    assert.equal(vars.get("SOURCED"), "1");
    assert.equal(vars.get("REPO"), repoRoot);
    assert.equal(vars.get("SUITE"), path.join(repoRoot, "scripts", "tests", "matchlock"));
    assert.equal(vars.get("WORKDIR"), path.join(repoRoot, "scripts", "tests", "matchlock", "work"));
    assert.match(vars.get("UID") ?? "", /^\d+$/);
    assert.match(vars.get("GID") ?? "", /^\d+$/);
    assert.equal(vars.get("ALLOW"), DEFAULT_ALLOW_PRIVATE);
    assert.equal(vars.get("ENDPOINT"), DEFAULT_ALLOW_PRIVATE);
    assert.equal(vars.get("MODE"), "candidate");
    assert.equal(vars.get("BACKEND"), "[]", "MTLK_BACKEND default must mean the matchlock default");
    assert.equal(vars.get("GATE"), DEFAULT_GATE_LOCK);
    for (const key of ["TIMEOUT_BOOT", "TIMEOUT_CASE", "TIMEOUT_T3", "TIMEOUT_T4"]) {
      assert.match(vars.get(key) ?? "", /^\d+$/, `${key} must be defined numeric`);
    }
    assert.equal(vars.get("T3_ENABLED"), "0");
  });

  it("resolves the matchlock pair from PATH before any PATH/HOME change", () => {
    const tmp = tamanduaTempDir("mtlk-common-runtime-");
    try {
      const binDir = path.join(tmp, "bin");
      mkdirSync(binDir, { recursive: true });
      writeStub(binDir, "matchlock", "#!/usr/bin/env bash\nexit 0\n");
      writeStub(binDir, "guest-init", "#!/usr/bin/env bash\nexit 0\n");

      const script = [
        RESET,
        `export PATH=${shQuote(binDir)}:"$PATH"`,
        `source ${shQuote(commonPath)}`,
        "mtlk_resolve_runtime",
        'printf "MB=%s\\n" "$MTLK_MATCHLOCK_RPC_BIN"',
        'printf "GI=%s\\n" "$MTLK_GUEST_INIT"',
      ].join("\n");
      const result = runBash(script);
      assert.equal(result.status, 0, `bash failed: ${result.stdout}${result.stderr}`);
      const vars = lineMap(result.stdout);
      assert.equal(vars.get("MB"), path.join(binDir, "matchlock"));
      assert.equal(vars.get("GI"), path.join(binDir, "guest-init"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("INSTALLED mode resolves tamandua from PATH and never runs a build", () => {
    const tmp = tamanduaTempDir("mtlk-common-installed-");
    try {
      const binDir = path.join(tmp, "bin");
      const stubDir = path.join(tmp, "stubs");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(stubDir, { recursive: true });
      const tamandua = writeStub(binDir, "tamandua", "#!/usr/bin/env bash\necho installed-tamandua\n");
      const sentinel = path.join(tmp, "npm-was-run");
      writeStub(
        stubDir,
        "npm",
        `#!/usr/bin/env bash\necho ran >> ${shQuote(sentinel)}\nexit 0\n`,
      );

      const script = [
        RESET,
        "export MTLK_MODE=installed",
        `export PATH=${shQuote(binDir)}:${shQuote(stubDir)}:"$PATH"`,
        `source ${shQuote(commonPath)}`,
        "mtlk_resolve_mode",
        'printf "BIN=%s\\n" "$MTLK_TAMANDUA_BIN"',
        'printf "ARGV0=%s\\n" "$MTLK_TAMANDUA_ARGV0"',
        'printf "SHA=%s\\n" "$MTLK_TAMANDUA_SHA"',
        'printf "PROV=%s\\n" "$MTLK_BUILD_PROVENANCE"',
      ].join("\n");
      const result = runBash(script);
      assert.equal(result.status, 0, `bash failed: ${result.stdout}${result.stderr}`);

      const vars = lineMap(result.stdout);
      assert.equal(vars.get("BIN"), tamandua, "INSTALLED must bind the PATH-resolved tamandua");
      assert.equal(vars.get("ARGV0"), "tamandua");
      assert.match(vars.get("PROV") ?? "", /mode=installed/);
      assert.match(vars.get("PROV") ?? "", /no-build/);
      assert.equal(existsSync(sentinel), false, "INSTALLED mode must not run npm run build");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("CANDIDATE mode builds the worktree dist and binds the candidate artifact", () => {
    const tmp = tamanduaTempDir("mtlk-common-candidate-");
    try {
      const fakeRepo = path.join(tmp, "repo");
      const stubDir = path.join(tmp, "stubs");
      mkdirSync(fakeRepo, { recursive: true });
      mkdirSync(stubDir, { recursive: true });
      const sentinel = path.join(tmp, "npm-was-run");
      writeStub(
        stubDir,
        "npm",
        [
          "#!/usr/bin/env bash",
          `echo ran >> ${shQuote(sentinel)}`,
          `mkdir -p ${shQuote(path.join(fakeRepo, "dist", "cli"))}`,
          `printf '%s\\n' '#!/usr/bin/env node' 'console.log("fake-cli", process.argv.slice(2).join(" "));' > ${shQuote(path.join(fakeRepo, "dist", "cli", "cli.js"))}`,
          `chmod +x ${shQuote(path.join(fakeRepo, "dist", "cli", "cli.js"))}`,
          "exit 0",
        ].join("\n"),
      );

      const script = [
        RESET,
        "export MTLK_MODE=candidate",
        `export MTLK_REPO_ROOT=${shQuote(fakeRepo)}`,
        `export PATH=${shQuote(stubDir)}:"$PATH"`,
        `source ${shQuote(commonPath)}`,
        "mtlk_resolve_mode",
        'printf "BIN=%s\\n" "$MTLK_TAMANDUA_BIN"',
        'printf "ARGV0=%s\\n" "$MTLK_TAMANDUA_ARGV0"',
        'printf "NODE=%s\\n" "$MTLK_NODE_BIN"',
        'printf "SHA=%s\\n" "$MTLK_TAMANDUA_SHA"',
        'printf "PROV=%s\\n" "$MTLK_BUILD_PROVENANCE"',
        "mtlk_run_tamandua alpha beta",
        '"$MTLK_TAMANDUA_ARGV0" gamma',
      ].join("\n");
      const result = runBash(script);
      assert.equal(result.status, 0, `bash failed: ${result.stdout}${result.stderr}`);

      const expectedCli = path.join(fakeRepo, "dist", "cli", "cli.js");
      const vars = lineMap(result.stdout);
      assert.equal(vars.get("BIN"), expectedCli, "CANDIDATE must bind <repo>/dist/cli/cli.js");
      assert.equal(
        vars.get("ARGV0"),
        expectedCli,
        "CANDIDATE argv0 must be the built cli.js (the PTY driver execs argv[0] directly)",
      );
      assert.equal(vars.get("SHA"), sha256File(expectedCli));
      assert.match(vars.get("PROV") ?? "", /mode=candidate/);
      assert.match(vars.get("PROV") ?? "", /dist_sha256=/);
      assert.equal(existsSync(sentinel), true, "CANDIDATE mode must run npm run build");
      assert.match(result.stdout, /fake-cli alpha beta/, "mtlk_run_tamandua must exec the candidate through node");
      assert.match(
        result.stdout,
        /fake-cli gamma/,
        "the candidate argv[0] must be directly executable (shebang cli.js)",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses a missing expected digest with the exact MTLK-ABORT line", () => {
    const missing = runBash(
      [RESET, `source ${shQuote(commonPath)}`, "mtlk_require_digest"].join("\n"),
    );
    assert.equal(missing.status, 2, `expected exit 2, got ${missing.status}`);
    assert.equal(
      missing.stdout.trim(),
      "MTLK-ABORT no-expected-digest",
      "the refusal line must be exactly MTLK-ABORT no-expected-digest",
    );

    const present = runBash(
      [
        RESET,
        "export MTLK_EXPECT_DIGEST=sha256:deadbeef",
        `source ${shQuote(commonPath)}`,
        "mtlk_require_digest",
        'printf "DIGEST-OK\\n"',
      ].join("\n"),
    );
    assert.equal(present.status, 0, `a present digest must not refuse: ${present.stdout}${present.stderr}`);
    assert.match(present.stdout, /DIGEST-OK/);
  });

  it("fails the capability probe closed with exit 3 and the exact line", () => {
    const tmp = tamanduaTempDir("mtlk-common-caps-");
    try {
      const missingPath = path.join(tmp, "does-not-exist");
      const trueBin = "/usr/bin/true";

      const kvm = runBash(
        [
          RESET,
          "export MTLK_REQUIRE_KVM=1",
          `export MTLK_KVM_DEVICE=${shQuote(missingPath)}`,
          `export MTLK_MATCHLOCK_RPC_BIN=${shQuote(trueBin)}`,
          `export MTLK_GUEST_INIT=${shQuote(trueBin)}`,
          `source ${shQuote(commonPath)}`,
          "mtlk_probe_capabilities",
        ].join("\n"),
      );
      assert.equal(kvm.status, 3, `expected exit 3, got ${kvm.status}`);
      assert.match(kvm.stdout, /^MTLK-CAPABILITY-UNAVAILABLE kvm-device-missing:/m);

      const matchlock = runBash(
        [
          RESET,
          "export MTLK_REQUIRE_KVM=0",
          `export MTLK_MATCHLOCK_RPC_BIN=${shQuote(path.join(missingPath, "matchlock"))}`,
          `export MTLK_GUEST_INIT=${shQuote(trueBin)}`,
          `source ${shQuote(commonPath)}`,
          "mtlk_probe_capabilities",
        ].join("\n"),
      );
      assert.equal(matchlock.status, 3, `expected exit 3, got ${matchlock.status}`);
      assert.match(matchlock.stdout, /^MTLK-CAPABILITY-UNAVAILABLE matchlock-not-executable:/m);

      const guestInit = runBash(
        [
          RESET,
          "export MTLK_REQUIRE_KVM=0",
          `export MTLK_MATCHLOCK_RPC_BIN=${shQuote(trueBin)}`,
          "export MTLK_REQUIRE_GUEST_INIT=1",
          "export MTLK_GUEST_INIT=",
          `source ${shQuote(commonPath)}`,
          "mtlk_probe_capabilities",
        ].join("\n"),
      );
      assert.equal(guestInit.status, 3, `expected exit 3, got ${guestInit.status}`);
      assert.match(guestInit.stdout, /^MTLK-CAPABILITY-UNAVAILABLE no-guest-init$/m);

      const usable = runBash(
        [
          RESET,
          "export MTLK_REQUIRE_KVM=0",
          `export MTLK_MATCHLOCK_RPC_BIN=${shQuote(trueBin)}`,
          `export MTLK_GUEST_INIT=${shQuote(trueBin)}`,
          `source ${shQuote(commonPath)}`,
          "mtlk_probe_capabilities",
          'printf "CAP-OK\\n"',
        ].join("\n"),
      );
      assert.equal(usable.status, 0, `a usable pair must pass: ${usable.stdout}${usable.stderr}`);
      assert.match(usable.stdout, /CAP-OK/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("gates T3 on explicit enablement AND credentials (never a silent pass)", () => {
    const base = (extra: string[]): string =>
      [
        RESET,
        `source ${shQuote(commonPath)}`,
        ...extra,
        "if mtlk_t3_ready; then printf \"T3-READY\\n\"; else printf \"T3-NOT-READY\\n\"; fi",
      ].join("\n");

    const disabled = runBash(
      base([
        "export MTLK_T3_ENABLED=0",
        "export MTLK_T3_CREDENTIAL_ENV=MTLK_MODEL_API_KEY",
        "export MTLK_MODEL_API_KEY=present",
      ]),
    );
    assert.equal(disabled.status, 0);
    assert.match(disabled.stdout, /T3-NOT-READY/, "T3 must not run without explicit enablement");

    const noCredentials = runBash(
      base([
        "export MTLK_T3_ENABLED=1",
        "export MTLK_T3_CREDENTIAL_ENV=MTLK_MODEL_API_KEY",
      ]),
    );
    assert.equal(noCredentials.status, 0);
    assert.match(noCredentials.stdout, /T3-NOT-READY/, "T3 must not run without credentials");

    const enabled = runBash(
      base([
        "export MTLK_T3_ENABLED=1",
        "export MTLK_T3_CREDENTIAL_ENV=MTLK_MODEL_API_KEY",
        "export MTLK_MODEL_API_KEY=present",
      ]),
    );
    assert.equal(enabled.status, 0);
    assert.match(enabled.stdout, /T3-READY/, "T3 must be available when enabled with credentials");
  });

  it("exports the configured backend without touching the matchlock default", () => {
    const unsetBackend = runBash(
      [
        RESET,
        `source ${shQuote(commonPath)}`,
        "mtlk_export_backend",
        'printf "BACKEND=[%s]\\n" "${MATCHLOCK_BACKEND:-unset}"',
      ].join("\n"),
    );
    assert.equal(unsetBackend.status, 0);
    assert.match(unsetBackend.stdout, /BACKEND=\[unset\]/);

    const qemuBackend = runBash(
      [
        RESET,
        "export MTLK_BACKEND=qemu",
        `source ${shQuote(commonPath)}`,
        "mtlk_export_backend",
        'printf "BACKEND=[%s]\\n" "${MATCHLOCK_BACKEND:-unset}"',
      ].join("\n"),
    );
    assert.equal(qemuBackend.status, 0);
    assert.match(qemuBackend.stdout, /BACKEND=\[qemu\]/);
  });
});
