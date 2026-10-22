/**
 * G1-B stock-runtime qualification — US-001 harness and artifact-truth
 * contract.
 *
 * US-001 establishes the Docker-scoped probe harness (single container gateway,
 * scratch-root rule, real-home refusal guard, raw-header bootstrap) and records
 * the precisely identified published artifact so every later per-store probe
 * runs against it.  This test pins that contract so a future edit cannot
 * weaken the harness, let a probe reach the real operator home, or silently
 * drop the artifact truth the qualification depends on.
 *
 * It spawns bash and (when available) docker, so the file is classified in the
 * serial lane.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "docs", "gate"))) return cwd;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
})();

const GATE_DIR = path.join(PROJECT_ROOT, "docs", "gate");
const G1B_DOC = path.join(GATE_DIR, "G1-B-STOCK-RUNTIME-QUALIFICATION.md");
const G1B_PROBES = path.join(GATE_DIR, "probes", "g1b");
const COMMON = path.join(G1B_PROBES, "g1b_common.sh");
const IDENTITY_PROBE = path.join(G1B_PROBES, "probe_runtime_identity.sh");
const EVIDENCE = path.join(GATE_DIR, "evidence", "g1b", "runtime-identity.txt");

const IMAGE_REF = "igorhvr/tamandua:latest";
const IMAGE_ID =
  "sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a";
const MATCHLOCK_IMAGE_ID =
  "sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff";
const HERMES_REVISION = "4d04303818b61bf3aa09278af48356315515965b";
const REAL_HOME = "/home/kaladin/.hermes";

const scratchRoots: string[] = [];
after(() => {
  for (const root of scratchRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scratchRoot(): string {
  const root = tamanduaTempDir("g1b-harness-");
  scratchRoots.push(root);
  return root;
}

const SPAWN_PATH = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";

/**
 * An explicit, minimal child environment.  Spreading `process.env` would let a
 * test inherit a live tamandua run's state pointers, which the isolation guard
 * forbids; the probe fixtures only need PATH plus their own G1B_* overrides.
 */
function spawnEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PATH: SPAWN_PATH, ...extra };
}

function runBash(script: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: spawnEnv(env),
    timeout: 60_000,
  });
}

const dockerImageAvailable = (() => {
  const probe = spawnSync(
    "docker",
    ["image", "inspect", IMAGE_REF, "--format", "{{.Id}}"],
    { encoding: "utf-8", timeout: 20_000, env: spawnEnv() },
  );
  return probe.status === 0 && probe.stdout.trim() === IMAGE_ID;
})();

describe("G1-B US-001 harness contract", () => {
  it("ships g1b_common.sh with the required artifact constants", () => {
    assert.ok(fs.existsSync(COMMON), `common library must exist at ${COMMON}`);
    const common = fs.readFileSync(COMMON, "utf-8");
    assert.match(common, /IMAGE_REF=.*igorhvr\/tamandua:latest/);
    assert.ok(common.includes(IMAGE_ID), "common must pin the required image id");
    assert.match(common, /REQUIRED_ARCH="amd64"/);
    assert.match(common, /REQUIRED_OS="linux"/);
    assert.ok(
      common.includes(HERMES_REVISION),
      "common must pin the stock Hermes revision",
    );
    assert.ok(
      common.includes(MATCHLOCK_IMAGE_ID),
      "common must record the Matchlock artifact id",
    );
    assert.ok(
      common.includes("UNVERIFIED"),
      "common must label the Matchlock artifact relationship unverified",
    );
  });

  it("every container gateway invocation carries the full safety flag set", () => {
    const common = fs.readFileSync(COMMON, "utf-8");
    const gateway = common.slice(common.indexOf("g1b_container_run()"));
    assert.ok(gateway.length > 0, "g1b_container_run must be defined");
    for (const flag of [
      "--rm",
      "--network none",
      "--platform \"$REQUIRED_PLATFORM\"",
      "--user \"$(id -u):$(id -g)\"",
      "-v \"$scratch:/work\"",
      "-w /work",
      "bash -c",
    ]) {
      assert.ok(
        gateway.includes(flag),
        `g1b_container_run must pass ${flag}`,
      );
    }
    assert.ok(
      !/^\s*[^#\n]*bash\s+-lc/m.test(common),
      "no login shell: bash -lc is unusable in the image",
    );
    assert.match(
      common,
      /REQUIRED_PLATFORM="linux\/\$\{REQUIRED_ARCH\}"/,
      "required platform must be derived from the required arch",
    );
  });

  it("per-store probes never call docker run directly", () => {
    assert.ok(fs.existsSync(IDENTITY_PROBE), "identity probe must exist");
    for (const name of fs.readdirSync(G1B_PROBES)) {
      if (!name.endsWith(".sh") || name === "g1b_common.sh") continue;
      const text = fs.readFileSync(path.join(G1B_PROBES, name), "utf-8");
      assert.ok(
        !/^[^#\n]*\bdocker\s+run\b/m.test(text),
        `${name} must use g1b_container_run, not docker run directly`,
      );
      assert.ok(
        !/^\s*[^#\n]*bash\s+-lc/m.test(text),
        `${name} must not use a login shell`,
      );
    }
  });

  it("refuses any scratch path resolving to the real operator home with exit 64", () => {
    const common = JSON.stringify(COMMON);
    const cases = [
      REAL_HOME,
      `${REAL_HOME}/state.db`,
      `${REAL_HOME}/nested/./deeper`,
    ];
    for (const target of cases) {
      const result = runBash(
        `. ${common}; g1b_refuse_real_home ${JSON.stringify(target)}`,
      );
      assert.equal(
        result.status,
        64,
        `expected exit 64 for ${target}, got ${result.status} (${result.stderr})`,
      );
      assert.match(result.stderr, /REFUSED/);
    }
  });

  it("refuses to create a scratch root whose base resolves into the real home", () => {
    const result = runBash(
      `. ${JSON.stringify(COMMON)}; g1b_scratch escape`,
      { G1B_TMP_ROOT: REAL_HOME },
    );
    assert.equal(result.status, 64, `expected exit 64, got ${result.status}`);
    assert.equal(result.stdout.trim(), "", "no scratch root may be printed");
  });

  it("creates scratch roots under the g1b-* base and keeps them", () => {
    const base = scratchRoot();
    const result = runBash(
      `. ${JSON.stringify(COMMON)}; r="$(g1b_scratch keep)"; printf '%s\\n' "$r"; test -d "$r" && echo ALIVE`,
      { G1B_TMP_ROOT: base },
    );
    assert.equal(result.status, 0, result.stderr);
    const [root, alive] = result.stdout.trim().split("\n");
    assert.match(path.basename(root), /^g1b-keep\./);
    assert.equal(alive, "ALIVE", "the scratch root must survive the probe");
    assert.ok(fs.existsSync(root), "scratch root must exist after the probe");
  });

  it("bootstraps read_header.py byte-identically into the scratch tools dir", () => {
    const root = scratchRoot();
    const result = runBash(
      `. ${JSON.stringify(COMMON)}; g1b_bootstrap_read_header ${JSON.stringify(root)}`,
    );
    assert.equal(result.status, 0, result.stderr);
    const copy = path.join(root, "tools", "read_header.py");
    const parent = path.join(GATE_DIR, "probes", "read_header.py");
    assert.ok(fs.existsSync(copy), "read_header.py must be copied");
    assert.deepEqual(fs.readFileSync(copy), fs.readFileSync(parent));
    assert.match(result.stdout, /sha256=[0-9a-f]{64}/);
  });
});

describe("G1-B US-001 artifact truth evidence", () => {
  it("records the tag->image-id mapping and stock runtime identity", () => {
    assert.ok(fs.existsSync(EVIDENCE), `evidence must exist at ${EVIDENCE}`);
    const evidence = fs.readFileSync(EVIDENCE, "utf-8");
    assert.ok(
      evidence.includes(`TAG_MAPPING ${IMAGE_REF} -> ${IMAGE_ID}`),
      "evidence must map the latest tag to the required image id",
    );
    assert.ok(
      evidence.includes(
        `TAG_MAPPING igorhvr/tamandua:amd64 -> ${MATCHLOCK_IMAGE_ID}`,
      ),
      "evidence must map the amd64 tag to the Matchlock artifact id",
    );
    assert.ok(evidence.includes(`GIT_REVISION=${HERMES_REVISION}`));
    assert.match(evidence, /GIT_STATUS_PORCELAIN_EMPTY=yes/);
    assert.match(evidence, /HERMES_VERSION=Hermes Agent /);
    assert.match(evidence, /PYTHON_VERSION=Python 3\./);
    assert.match(evidence, /SQLITE_VERSION=\d+\.\d+/);
    assert.match(evidence, /IMPORT_HERMES_STATE=IMPORT_OK/);
    assert.match(evidence, /RESOLVED_DELETE=delete/);
    assert.match(evidence, /RESOLVED_WAL=wal/);
    assert.match(evidence, /CONTAINER_RC=0/);
    assert.match(evidence, /SCRATCH_ROOT=\S*g1b-runtime-identity\./);
    assert.match(evidence, /SCRATCH_ROOT_KEPT=yes/);
    assert.match(evidence, /UNVERIFIED/);
  });

  it("runs the identity probe green end to end (docker required)", async (t) => {
    if (!dockerImageAvailable) {
      t.skip(`docker image ${IMAGE_REF} (${IMAGE_ID}) is not available locally`);
      return;
    }
    const evidenceDir = scratchRoot();
    const base = scratchRoot();
    const result = spawnSync("bash", [IDENTITY_PROBE], {
      encoding: "utf-8",
      timeout: 300_000,
      env: spawnEnv({
        G1B_EVIDENCE_DIR: evidenceDir,
        G1B_TMP_ROOT: base,
      }),
    });
    assert.equal(
      result.status,
      0,
      `identity probe must exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /ASSERT SUMMARY: pass=\d+ fail=0/);
    const written = fs.readFileSync(
      path.join(evidenceDir, "runtime-identity.txt"),
      "utf-8",
    );
    assert.ok(written.includes(`TAG_MAPPING ${IMAGE_REF} -> ${IMAGE_ID}`));
    assert.ok(written.includes(`GIT_REVISION=${HERMES_REVISION}`));
    assert.match(written, /RESOLVED_DELETE=delete/);
    assert.match(written, /RESOLVED_WAL=wal/);
  });
});

describe("G1-B US-001 qualification document", () => {
  it("contains Status, Scope, Artifact Truth and Safety Protocol sections", () => {
    assert.ok(fs.existsSync(G1B_DOC), `document must exist at ${G1B_DOC}`);
    const doc = fs.readFileSync(G1B_DOC, "utf-8");
    for (const heading of [
      "## Status",
      "## Scope",
      "## Artifact Truth",
      "## Safety Protocol",
    ]) {
      assert.ok(doc.includes(heading), `document must contain ${heading}`);
    }
  });

  it("states the container result does not qualify Matchlock guest-boundary behaviour", () => {
    const doc = fs.readFileSync(G1B_DOC, "utf-8");
    assert.match(doc, /does NOT qualify Matchlock'?s? shared-filesystem behaviour across a guest\s+boundary/);
    assert.match(doc, /do that image'?s writers honour configuration/);
  });

  it("records the docker artifact and the UNVERIFIED Matchlock relationship", () => {
    const doc = fs.readFileSync(G1B_DOC, "utf-8");
    assert.ok(doc.includes(IMAGE_ID), "document must record the image id");
    assert.ok(doc.includes(MATCHLOCK_IMAGE_ID), "document must record the Matchlock artifact id");
    assert.match(doc, /Architecture \| `amd64`/);
    assert.match(doc, /\bamd64\b/);
    assert.ok(doc.includes(HERMES_REVISION), "document must record the stock revision");
    assert.match(
      doc,
      /relationship between the Docker artifact qualified here and the Matchlock\s+artifact is UNVERIFIED/,
    );
    assert.ok(
      doc.includes("sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a"),
    );
  });

  it("documents the BLOCKER policy and what remains unproven", () => {
    const doc = fs.readFileSync(G1B_DOC, "utf-8");
    assert.match(doc, /## What remains unproven/);
    assert.match(doc, /## BLOCKER policy/);
    assert.match(doc, /preserve the reproducer/);
  });
});
