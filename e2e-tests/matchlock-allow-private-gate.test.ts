/******************************************************************************
 * ⚠️  WARNING: SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-ALLOW-PRIVATE US-009 — the real-VM `--matchlock-allow-private` gate.
 *
 * NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand only:
 *
 *   ./run-matchlock-allow-private-e2e-test
 *
 * which takes the SHARED gate lock (`flock --exclusive
 * /home/kaladin/matchlock-work/vaivm-gate.lock`), builds first, resolves the
 * system matchlock pair, seeds the operator image store, allocates a NEW
 * mkdtemp evidence dir with a private HOME/TMPDIR, runs this file, then
 * invokes `scripts/observed-rounds-guard.mjs --gate allow-private` (exit 92 on
 * a zero-round pass).
 *
 * What it proves: do-now runs TWICE through an isolated daemon → scheduler →
 * fresh Matchlock VM with the TEST-ONLY synthetic-pi fixture whose in-guest
 * curl probe (default-off; enabled for this gate through the fixture image's
 * build arg) targets the private endpoint 192.168.107.74:8888:
 *
 *   - RUN A: `--matchlock-allow-private 192.168.107.74:8888` → the run must
 *     complete and the in-guest curl probe must exit 0 WITH a response body;
 *   - RUN B: no allow-private flag (same image, same endpoint) → the run must
 *     complete while the in-guest curl probe records a REFUSAL (nonzero).
 *
 * Both rounds dispatch through the REAL per-run Matchlock policy. The gate
 * asserts its daemon child env does NOT contain
 * TAMANDUA_MATCHLOCK_TEMP_ALLOW_PRIVATE (the temporary host exemption this
 * change must not depend on), that every probe/work invocation used a FRESH
 * VM (distinct ids; no reuse), positively tears down every owned VM by exact
 * id, and writes observed-rounds.json for the no-fake-green guard.
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB under the evidence dir, a
 * random control port, the operator matchlock image store seeded read-only,
 * and the TEST-ONLY fixture image built + imported into the private store.
 * Never the live worker daemon or the operator's real state.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanChildEnv, reservePortHandles } from "../tests/helpers/test-env.ts";
import {
  baseEnv,
  cliMustSucceed,
  inheritedProcessEnv,
  releasePortReservations,
  resolveFullRunId,
  spawnWorkflowRun,
} from "./helpers/smoke-helpers.ts";
import {
  pollForRunCompletionWithNudge,
  startIsolatedDaemon,
} from "./helpers/e2e-helpers.ts";
import {
  assertNoOwnedVms,
  cleanupOwnedVms,
  readRunnerVmEvidenceIds,
  readVmInventory,
  stopIsolatedDaemonScoped,
} from "./helpers/matchlock-gate-lifecycle.ts";
import {
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";
import {
  ALLOW_PRIVATE_PROBE_URL,
  CURL_PROBE_ENV,
  TEMP_ALLOW_PRIVATE_ENV,
  assertCurlProbeReached,
  assertCurlProbeRefused,
  buildDoNowRunArgs,
  daemonEnvLeaksTempExemption,
  readCurlProbeMarker,
  withoutTempAllowPrivate,
} from "./helpers/matchlock-allow-private-probe.ts";
import type { ChildProcess } from "node:child_process";
import type { PortHandle } from "../tests/helpers/test-env.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── resolved (unpinned) paired runtime + operator image store ─────────────
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";
const OPERATOR_CACHE = process.env.TAMANDUA_GATE_OPERATOR_CACHE ?? "";

// Deterministic TEST-ONLY fixture image tag (never igorhvr/bedlam-ubuntu).
const FIXTURE_IMAGE_TAG = "tamandua-synthetic-pi:allow-private-fixture";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "matchlock-fixture");
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-pi";

const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";
const GATE_LABEL = "allow-private";

const RUN_TIMEOUT_MS = 25 * 60_000;
const DEFAULT_POLL_MS = 2_000;
/** do-now per run = one launch harness probe + one work round. */
const EXPECTED_ROUNDS_PER_RUN = 2;

let homeDir = "";
let tamanduaDir = "";
let env: Record<string, string> = {};
let daemon: ChildProcess | null = null;
let portHandles: PortHandle[] = [];
let controlPort = 0;
let fixturesRoot = "";
let wdA = "";
let wdB = "";
let ledgerPath = "";
let assertionLedgerPath = "";
let runAId = "";
let runBId = "";
let cleanupCompleted = false;

const observedVmIds: string[] = [];

function matchlockRuntimeEnv(): Record<string, string> {
  const runtime: Record<string, string> = { TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN };
  if (GUEST_INIT.length > 0) runtime.MATCHLOCK_GUEST_INIT = GUEST_INIT;
  if (GUEST_FUSED.length > 0) runtime.MATCHLOCK_GUEST_FUSED = GUEST_FUSED;
  return runtime;
}

function assertEnv(): void {
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-allow-private-e2e-test)",
  );
  assert.ok(
    MATCHLOCK_RPC_BIN.length > 0,
    "TAMANDUA_MATCHLOCK_RPC_BIN must be set (the runner resolves matchlock from PATH)",
  );
  // Guest-init/fused are OPTIONAL (MTLK-UNPIN): when unset, matchlock resolves
  // them itself and the gate records whatever it observes.
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    if (p.length > 0) assert.ok(fs.existsSync(p), `resolved runtime binary missing: ${p}`);
  }
  assert.ok(
    OPERATOR_CACHE.length > 0,
    "TAMANDUA_GATE_OPERATOR_CACHE (the operator ~/.cache/matchlock store) must be set",
  );
  assert.ok(
    fs.existsSync(path.join(OPERATOR_CACHE, "kernels")),
    `operator matchlock kernel cache missing under ${OPERATOR_CACHE}`,
  );
}

function writeEvidence(name: string, content: string): string {
  const target = path.join(EVIDENCE_DIR, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf-8");
  return target;
}

function gateEnv(homeDirArg: string, controlPortArg: number): Record<string, string> {
  const tamanduaDirArg = path.join(homeDirArg, ".tamandua");
  return {
    ...inheritedProcessEnv(),
    HOME: homeDirArg,
    TAMANDUA_CONTROL_PORT: String(controlPortArg),
    TAMANDUA_STATE_DIR: tamanduaDirArg,
    TAMANDUA_DB_PATH: path.join(tamanduaDirArg, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDirArg, "worktrees"),
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_HARNESS_PROBE: "1",
    TAMANDUA_PI_BINARY: "/usr/bin/false",
    TAMANDUA_DSH_BINARY: "/usr/bin/false",
    ...matchlockRuntimeEnv(),
  };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Fresh small git repo (clean tracked tree) for one synthetic run. */
function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, "README.md"),
    "# Matchlock allow-private gate fixture\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(targetDir, ".gitignore"),
    "*.log\n.matchlock-synthetic-pi/\n",
    "utf-8",
  );
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Matchlock Allow-Private Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

/** Seed the private matchlock image store from the operator store (read-only). */
function seedOperatorImageStore(operatorCache: string, homeDirArg: string): void {
  const src = path.join(operatorCache, "images");
  const dst = path.join(homeDirArg, ".cache", "matchlock", "images");
  fs.mkdirSync(dst, { recursive: true });
  const srcBlobs = path.join(src, "blobs");
  if (fs.existsSync(srcBlobs) && fs.readdirSync(srcBlobs).length > 0) {
    const linked = spawnSync("cp", ["-al", srcBlobs, path.join(dst, "blobs")], {
      encoding: "utf-8",
    });
    if (linked.status !== 0) {
      const copied = spawnSync(
        "cp",
        ["-a", "--reflink=auto", srcBlobs, path.join(dst, "blobs")],
        { encoding: "utf-8" },
      );
      assert.equal(
        copied.status,
        0,
        `seeding operator image blobs failed (hardlink: ${linked.stderr}; copy: ${copied.stderr})`,
      );
    }
  }
  for (const meta of ["metadata.db", "metadata.db-wal", "metadata.db-shm"]) {
    const from = path.join(src, meta);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, meta));
  }
  const local = path.join(src, "local");
  if (fs.existsSync(local)) fs.cpSync(local, path.join(dst, "local"), { recursive: true });
}

/**
 * Build the TEST-ONLY synthetic-pi fixture image with the in-guest curl probe
 * URL baked in (build arg → image config env), then save + import it into the
 * private matchlock store. No model calls, no provider credentials.
 */
function buildAndImportFixtureImage(): void {
  const dockerBuild = spawnSync(
    "/usr/bin/docker",
    [
      "build",
      "-f",
      FIXTURE_DOCKERFILE,
      "-t",
      FIXTURE_IMAGE_TAG,
      "--build-arg",
      `${CURL_PROBE_ENV}=${ALLOW_PRIVATE_PROBE_URL}`,
      ".",
    ],
    {
      cwd: FIXTURE_DOCKER_DIR,
      encoding: "utf-8",
      env: inheritedProcessEnv(),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(
    dockerBuild.status,
    0,
    `docker build of the allow-private fixture failed (exit ${dockerBuild.status}, signal ${dockerBuild.signal}):\n${(dockerBuild.stdout || "").slice(-4000)}\n${(dockerBuild.stderr || "").slice(-4000)}`,
  );
  const fixtureTar = path.join(EVIDENCE_DIR, "fixture-image.tar");
  const saveOutFd = fs.openSync(fixtureTar, "w");
  const dockerSave = spawnSync("/usr/bin/docker", ["save", FIXTURE_IMAGE_TAG], {
    stdio: ["ignore", saveOutFd, "pipe"],
    env: inheritedProcessEnv(),
  });
  fs.closeSync(saveOutFd);
  assert.equal(
    dockerSave.status,
    0,
    `docker save of the allow-private fixture failed: ${dockerSave.stderr}`,
  );
  const importEnv = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
  const saveInFd = fs.openSync(fixtureTar, "r");
  const imageImport = spawnSync(MATCHLOCK_RPC_BIN, ["image", "import", FIXTURE_IMAGE_TAG], {
    encoding: "utf-8",
    stdio: [saveInFd, "pipe", "pipe"],
    env: importEnv,
  });
  fs.closeSync(saveInFd);
  assert.equal(
    imageImport.status,
    0,
    `matchlock image import failed: ${imageImport.stdout}\n${imageImport.stderr}`,
  );
  const resolved = spawnSync(MATCHLOCK_RPC_BIN, ["image", "resolve", FIXTURE_IMAGE_TAG], {
    encoding: "utf-8",
    env: importEnv,
  });
  assert.equal(resolved.status, 0, `matchlock image resolve failed: ${resolved.stderr}`);
}

// ── live per-invocation VM sampling (fresh-VM proofs) ─────────────────────
interface VmSampler {
  ids: Set<string>;
  samples: number;
  timer: NodeJS.Timeout | null;
}

function startVmSampler(): VmSampler {
  const sampler: VmSampler = { ids: new Set(), samples: 0, timer: null };
  const sample = (): void => {
    try {
      const inventory = readVmInventory(homeDir);
      for (const row of inventory.rows) sampler.ids.add(row.id);
      for (const id of inventory.dirIds) sampler.ids.add(id);
      sampler.samples += 1;
    } catch (err) {
      process.stderr.write(
        `[matchlock-allow-private-gate] VM inventory sample failed: ${String(err)}\n`,
      );
    }
  };
  sample();
  sampler.timer = setInterval(sample, 250);
  return sampler;
}

function stopVmSampler(sampler: VmSampler): string[] {
  if (sampler.timer) clearInterval(sampler.timer);
  sampler.timer = null;
  const ids = [...sampler.ids].sort();
  const distinct = new Set(ids);
  writeEvidence(
    "vm-receipts.json",
    `${JSON.stringify(
      {
        gate: GATE_LABEL,
        samples: sampler.samples,
        total: ids.length,
        distinct: distinct.size,
        observed_vm_ids: ids,
      },
      null,
      2,
    )}\n`,
  );
  return ids;
}

describe(
  "matchlock allow-private gate: the private endpoint is reachable only with --matchlock-allow-private",
  { concurrency: 1 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      homeDir = path.join(EVIDENCE_DIR, "home");
      tamanduaDir = path.join(homeDir, ".tamandua");
      fs.mkdirSync(tamanduaDir, { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".cache"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "agent", "settings.json"),
        JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
        "utf-8",
      );
      fs.writeFileSync(path.join(tamanduaDir, "port"), "0", "utf-8");

      // Kernel cache for the fresh matchlock state (never mutate the operator
      // cache). The operator cache is seeded read-only + hardlinked blobs.
      fs.cpSync(
        path.join(OPERATOR_CACHE, "kernels"),
        path.join(homeDir, ".cache", "matchlock", "kernels"),
        { recursive: true },
      );
      seedOperatorImageStore(OPERATOR_CACHE, homeDir);

      // The controller's pre-flight SUN_LEN guard must pass for the private HOME.
      const longest = path.join(homeDir, ".matchlock", "vms", "vm-12345678", "vsock.sock_5001");
      assert.ok(
        Buffer.byteLength(longest) < 108,
        `private gate HOME makes the matchlock socket path too long: ${longest}`,
      );

      buildAndImportFixtureImage();

      portHandles = await reservePortHandles(1);
      controlPort = portHandles[0].port;
      fs.writeFileSync(path.join(tamanduaDir, "port"), String(controlPort), "utf-8");
      env = gateEnv(homeDir, controlPort);

      cliMustSucceed(["workflow", "install", "do-now"], env, "install do-now workflow");

      fixturesRoot = path.join(EVIDENCE_DIR, "fixtures");
      wdA = prepareFixtureRepo(path.join(fixturesRoot, "wd-allow"));
      wdB = prepareFixtureRepo(path.join(fixturesRoot, "wd-deny"));
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");
      assertionLedgerPath = path.join(EVIDENCE_DIR, "vm-no-owned-assertions.txt");
    });

    after(async () => {
      const errors: string[] = [];
      if (daemon) {
        try {
          const closeOutcome = await stopIsolatedDaemonScoped(daemon);
          if (closeOutcome.signal === "SIGKILL-timeout") {
            errors.push("gate daemon did not close within the scoped bound");
          }
        } catch (err) {
          errors.push(`daemon stop: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          daemon = null;
        }
      }
      if (homeDir && !cleanupCompleted) {
        try {
          cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
        } catch (err) {
          errors.push(`emergency VM cleanup: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await releasePortReservations({ portHandles }).catch(() => {});
      portHandles = [];

      // ── observed-rounds honesty (no-fake-green) ─────────────────────
      const observedRounds = new Set(observedVmIds).size;
      if (EVIDENCE_DIR.length > 0) {
        writeObservedRoundsEvidence(EVIDENCE_DIR, {
          gate: GATE_LABEL,
          observed_rounds: observedRounds,
          observed_vm_ids: observedVmIds,
          detail: `${GATE_LABEL}: ${observedRounds} distinct in-VM rounds observed across the with-flag and without-flag do-now runs`,
        });
      }
      try {
        assertObservedRoundsNonZero(GATE_LABEL, observedRounds, observedVmIds);
      } catch (err) {
        errors.push(`observed-rounds: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (errors.length > 0) {
        throw new Error(`gate after-hook failure:\n${errors.join("\n")}`);
      }
    });

    it(
      "run A (with flag) reaches the endpoint; run B (without flag) is refused",
      { timeout: 90 * 60_000 },
      async () => {
        // ── daemon env MUST NOT carry the temporary host exemption ──────
        const rawDaemonEnv = gateEnv(homeDir, controlPort);
        assert.ok(
          !daemonEnvLeaksTempExemption(rawDaemonEnv),
          `${TEMP_ALLOW_PRIVATE_ENV} must NOT be present in the gate's daemon env`,
        );
        const daemonEnv = withoutTempAllowPrivate(rawDaemonEnv);
        const actualChildEnv = cleanChildEnv({ ...baseEnv(homeDir, controlPort), ...daemonEnv });
        assert.ok(
          !daemonEnvLeaksTempExemption(actualChildEnv),
          `${TEMP_ALLOW_PRIVATE_ENV} must NOT reach the daemon child`,
        );
        writeEvidence(
          "daemon-env.json",
          `${JSON.stringify(
            {
              gate: GATE_LABEL,
              tempExemptionKey: TEMP_ALLOW_PRIVATE_ENV,
              tempExemptionPresent: false,
              curlProbeEnvImageArg: `${CURL_PROBE_ENV}=${ALLOW_PRIVATE_PROBE_URL}`,
              matchlockAllowPrivateKeys: Object.keys(actualChildEnv)
                .filter((k) => k.startsWith("TAMANDUA_MATCHLOCK_"))
                .sort(),
            },
            null,
            2,
          )}\n`,
        );

        await releasePortReservations({ portHandles });
        portHandles = [];
        daemon = await startIsolatedDaemon(homeDir, controlPort, daemonEnv);

        const sampler = startVmSampler();
        try {
          // ── RUN A: do-now WITH --matchlock-allow-private ──────────
          const runAPrompt =
            "Allow-private gate run A: execute the harmless owned fixture action, curl the allow-private endpoint and report.";
          const prefixA = await spawnWorkflowRun(
            buildDoNowRunArgs({
              workDir: wdA,
              prompt: runAPrompt,
              imageTag: FIXTURE_IMAGE_TAG,
              allowPrivate: [ALLOW_PRIVATE_PROBE_URL],
            }),
            env,
            60_000,
          );
          runAId = resolveFullRunId(prefixA, tamanduaDir);
          const statusA = await pollForRunCompletionWithNudge(
            runAId,
            env,
            RUN_TIMEOUT_MS,
            DEFAULT_POLL_MS,
            tamanduaDir,
          );
          assert.equal(statusA, "completed", `run A (with flag) must complete; got ${statusA}`);
          await sleep(500);

          const markerA = readCurlProbeMarker(wdA);
          assertCurlProbeReached(markerA);
          writeEvidence("curl-probe-run-a.json", `${JSON.stringify(markerA, null, 2)}\n`);

          assertNoOwnedVms(homeDir, "run A: post-run", {
            pollTimeoutMs: 120_000,
            rpcBin: MATCHLOCK_RPC_BIN,
            ledgerPath: assertionLedgerPath,
          });

          // ── RUN B: do-now WITHOUT the flag ────────────────────────
          const runBPrompt =
            "Allow-private gate run B: execute the harmless owned fixture action, curl the blocked endpoint and report.";
          const prefixB = await spawnWorkflowRun(
            buildDoNowRunArgs({
              workDir: wdB,
              prompt: runBPrompt,
              imageTag: FIXTURE_IMAGE_TAG,
            }),
            env,
            60_000,
          );
          runBId = resolveFullRunId(prefixB, tamanduaDir);
          const statusB = await pollForRunCompletionWithNudge(
            runBId,
            env,
            RUN_TIMEOUT_MS,
            DEFAULT_POLL_MS,
            tamanduaDir,
          );
          assert.equal(statusB, "completed", `run B (without flag) must complete; got ${statusB}`);
          await sleep(500);

          const markerB = readCurlProbeMarker(wdB);
          assertCurlProbeRefused(markerB);
          writeEvidence("curl-probe-run-b.json", `${JSON.stringify(markerB, null, 2)}\n`);

          assertNoOwnedVms(homeDir, "run B: post-run", {
            pollTimeoutMs: 120_000,
            rpcBin: MATCHLOCK_RPC_BIN,
            ledgerPath: assertionLedgerPath,
          });

          // ── fresh-VM proof: distinct ids for every probe/work round ──
          const sampled = stopVmSampler(sampler);
          const evidenceIds = [
            ...readRunnerVmEvidenceIds(path.join(tamanduaDir, "runs"), runAId),
            ...readRunnerVmEvidenceIds(path.join(tamanduaDir, "runs"), runBId),
          ];
          observedVmIds.push(...new Set([...sampled, ...evidenceIds]));
          const distinct = new Set(observedVmIds);
          assert.ok(
            distinct.size >= EXPECTED_ROUNDS_PER_RUN * 2,
            `expected >= ${EXPECTED_ROUNDS_PER_RUN * 2} distinct fresh VMs (2 probes + 2 work rounds), got ${distinct.size}: ${[...distinct].join(",")}`,
          );
          assert.equal(
            observedVmIds.length,
            distinct.size,
            "VM ids must never repeat (fresh VM per probe/work invocation)",
          );

          // ── whole-path assertions: no refusal / infra / fallback ────
          for (const [label, runId] of [
            ["run A", runAId],
            ["run B", runBId],
          ] as const) {
            const events = readRunEventsStrict(tamanduaDir, runId);
            const byType = new Map<string, number>();
            for (const event of events) {
              const key = String(event.event);
              byType.set(key, (byType.get(key) ?? 0) + 1);
            }
            assert.ok(
              (byType.get("run.completed") ?? 0) === 1,
              `${label}: expected exactly one run.completed event`,
            );
            for (const bad of [
              "run.matchlock_dispatch_refused",
              "run.matchlock_invocation_infra_failed",
              "run.harness_probe_failed",
              "run.instant_fail_loop",
            ]) {
              assert.equal(byType.get(bad) ?? 0, 0, `${label}: unexpected ${bad} event`);
            }
          }
        } finally {
          if (sampler.timer) clearInterval(sampler.timer);
          if (daemon) {
            try {
              const closeOutcome = await stopIsolatedDaemonScoped(daemon);
              assert.ok(
                closeOutcome.signal !== "SIGKILL-timeout",
                `gate daemon did not close within the scoped bound (code=${closeOutcome.code}, signal=${closeOutcome.signal})`,
              );
            } finally {
              daemon = null;
            }
          }
        }

        // ── positive exact-owned teardown + ledger ───────────────────
        const { ledger } = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, {
          rpcBin: MATCHLOCK_RPC_BIN,
        });
        cleanupCompleted = true;
        assert.ok(fs.existsSync(ledgerPath), `vm cleanup ledger missing at ${ledgerPath}`);
        assert.ok(
          ledger.some((line) => /cleanup complete: no owned VM rows\/state dirs remain/.test(line)),
          "cleanup ledger must record completion with no leftovers",
        );
        console.log(
          `[matchlock-allow-private-gate] OK runA=${runAId} runB=${runBId} vms=${observedVmIds.length} distinct=${new Set(observedVmIds).size}`,
        );
      },
    );
  },
);

/**
 * Read run-scoped events strictly: corrupt JSON is an ERROR (a corrupt event
 * ledger must fail the gate loudly, never be silently treated as empty).
 */
function readRunEventsStrict(
  tamanduaDirArg: string,
  runId: string,
): Array<Record<string, unknown>> {
  const eventsPath = path.join(tamanduaDirArg, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  const events: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(eventsPath, "utf-8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      throw new Error(`corrupt event JSON in ${eventsPath}: ${line.slice(0, 200)}`);
    }
  }
  return events;
}
