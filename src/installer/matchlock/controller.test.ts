import { describe, it, before, after } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MatchlockController } from "../../../dist/installer/matchlock/controller.js";
import { writeFakeRpcDriver, tempTranscriptPath } from "../../../dist/installer/matchlock/fake-rpc-driver.js";
import { dshProfileOverlayRoot } from "../../../dist/installer/matchlock/dsh-profile-overlay.js";
import type { PinnedImageIdentity } from "../../../dist/installer/matchlock/image.js";
import type { ExecutionIsolation } from "../../../dist/installer/matchlock/policy.js";
import { MATCHLOCK_NETWORK_POLICY_VERSION } from "../../../dist/installer/matchlock/policy.js";
import type { MatchlockStreamFrame } from "../../../dist/installer/matchlock/types.js";
import { decodeFramesText, MATCHLOCK_CLIENT_ERROR_CODES } from "../../../dist/installer/matchlock/rpc-client.js";

const FAKE_ENV_KEYS = [
  "FAKE_IMAGE_TAG",
  "FAKE_IMAGE_DIGEST",
  "FAKE_IMAGE_CONFIG_DIGEST",
  "FAKE_CREATE_ACTUAL_DIGEST",
  "FAKE_CREATE_ACTUAL_CONFIG_DIGEST",
  "FAKE_CREATE_REJECT_IMAGE_IDENTITY",
  "FAKE_CREATE_HANG",
  "FAKE_CREATE_DELAY_MS",
  "FAKE_RESOLVE_MISSING",
  "FAKE_RESOLVE_HANG",
  "FAKE_RESOLVE_DELAY_MS",
  "FAKE_EXEC_STDOUT",
  "FAKE_EXEC_STDERR",
  "FAKE_EXEC_EXIT",
  "FAKE_ECHO_STDIN",
  "FAKE_SPLIT_UTF8_STDOUT",
  "FAKE_STDOUT_BEFORE_READY",
  "FAKE_DELAY_READY_MS",
  "FAKE_NO_READY",
  "FAKE_PIPE_WAIT_MS",
  "FAKE_CANCEL_BLOCK_MS",
  "FAKE_EMIT_OVERSIZE_ON_START",
  "FAKE_STREAM_STDOUT_BYTES",
  "FAKE_CLOSE_FAIL",
  "FAKE_CLOSE_ERROR_MESSAGE",
  "FAKE_CLOSE_DELAY_MS",
  "FAKE_HOLD_OPEN",
  "FAKE_EXIT_AFTER_CREATE_MS",
  "FAKE_TRANSCRIPT_FILE",
];

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll (bounded) until `cond` is true; tests then assert the expected state
 *  (a poll is never itself an assertion — it only bounds the wait). */
async function pollUntil(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await delay(10);
}

/** Default valid content+config pin matching policy tag "img:1". */
function pin(digest = "sha256:aaaa", configDigest = "sha256:bbbb", tag = "img:1"): PinnedImageIdentity {
  return { digest, config_digest: configDigest, tag };
}

function snapshotFakeEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of FAKE_ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreFakeEnv(saved: Record<string, string | undefined>): void {
  for (const k of FAKE_ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function policy(over: Partial<ExecutionIsolation> = {}): ExecutionIsolation {
  const base: ExecutionIsolation = {
    version: 1,
    backend: "matchlock",
    requestedImage: "img:1",
    harness: "pi",
    configurationRoot: "/opt/config/pi",
    configurationProfile: "settings.json",
    guestConfigurationRoot: "/workspace/config/pi",
    workPathMode: "host-absolute",
    workingDirectory: "/opt/project",
    workMounts: [{ hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" }],
    originalRepositoryRoot: "/opt/project",
    gitMetadataRoots: ["/opt/project/.git"],
    mountPolicyVersion: 1,
    networkPolicyVersion: MATCHLOCK_NETWORK_POLICY_VERSION,
    resourceLimits: { cpus: 2, memoryMB: 2048, diskSizeMB: 20480 },
  };
  return { ...base, ...over };
}

/** dsh harness policy: the config root is a composed DSH_HOME (US-002). */
function dshPolicy(over: Partial<ExecutionIsolation> = {}): ExecutionIsolation {
  return policy({
    harness: "dsh",
    guestConfigurationRoot: "/workspace/config/dsh",
    ...over,
  });
}

describe("matchlock controller (fake rpc driver)", () => {
  let tmp: string;
  let configDir: string;
  let helperPack: string;
  let fakeDriver: string;
  let savedEnv: Record<string, string | undefined>;
  const transcriptDirs: string[] = [];

  before(() => {
    tmp = tamanduaTempDir("tamandua-mtlk-controller-");
    configDir = path.join(tmp, "config-pi");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "settings.json"), "{}", "utf8");
    helperPack = path.join(tmp, "runtime");
    fs.mkdirSync(helperPack, { recursive: true });
    fs.writeFileSync(path.join(helperPack, "bin-tamandua"), "#!/bin/sh\n", "utf8");
    fakeDriver = writeFakeRpcDriver({ dir: path.join(tmp, "driver") });
    savedEnv = snapshotFakeEnv();
  });
  after(() => {
    restoreFakeEnv(savedEnv);
    for (const d of transcriptDirs) fs.rmSync(d, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Every test owns a fresh transcript so transcript assertions never leak
   *  across tests, and a per-test env snapshot is restored in t.after even
   *  when an assertion fails. */
  function testScaffold(t: { after: (fn: () => Promise<unknown> | void) => void }): {
    setFake: (opts: Record<string, string | undefined>) => void;
    readTranscript: () => Array<Record<string, unknown>>;
    makeController: (p?: ExecutionIsolation, over?: Record<string, number>) => MatchlockController;
  } {
    const saved = snapshotFakeEnv();
    const transcriptPath = tempTranscriptPath();
    transcriptDirs.push(path.dirname(transcriptPath));
    // Every test's spawned driver records its requests into THIS test's own
    // transcript (never shared mutable state across tests).
    process.env.FAKE_TRANSCRIPT_FILE = transcriptPath;
    t.after(() => {
      restoreFakeEnv(saved);
    });
    return {
      setFake: (opts: Record<string, string | undefined>) => {
        for (const [k, v] of Object.entries(opts)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      },
      readTranscript: () => {
        if (!fs.existsSync(transcriptPath)) return [];
        return fs
          .readFileSync(transcriptPath, "utf8")
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as Record<string, unknown>);
      },
      makeController: (p: ExecutionIsolation = policy(), over: Record<string, number> = {}, rpcEnv?: Record<string, string>) => {
        const c = new MatchlockController(p, {
          rpcBinaryPath: process.execPath,
          rpcArgs: [fakeDriver],
          helperPackHostPath: helperPack,
          // Isolation: capture diagnostics instead of the default logger, which
          // would write to the real ~/.tamandua state (guard ledger violation).
          onLog: () => {},
          requestTimeoutMs: 10_000,
          readyTimeoutMs: 3_000,
          stdinDrainTimeoutMs: 3_000,
          execCancelSettleTimeoutMs: 3_000,
          ...over,
          ...(rpcEnv ? { rpcEnv } : {}),
        });
        // Clean up the OWNED fake RPC child on success AND on assertion
        // failure: a leaked child keeps the test process alive forever.
        t.after(() => c.dispose());
        return c;
      },
    };
  }

  function transcriptMethodIndexes(txn: Array<Record<string, unknown>>, method: string): number[] {
    return txn
      .map((e, i) => (e.method === method ? i : -1))
      .filter((i) => i >= 0);
  }

  function transcriptMethods(txn: Array<Record<string, unknown>>): Array<string | undefined> {
    return txn.map((e) => (typeof e.method === "string" ? (e.method as string) : undefined)).filter((m): m is string => m !== undefined);
  }

  function codeOf(o: unknown): string | undefined {
    return typeof o === "object" && o !== null ? (o as { code?: string }).code : undefined;
  }

  function rpcCodeOf(o: unknown): number | undefined {
    return typeof o === "object" && o !== null ? (o as { code?: number }).code : undefined;
  }

  /** Mark a promise handled IMMEDIATELY so a rejection that beats our later
   *  assertion cannot surface as an unhandled rejection. */
  async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    try {
      return { ok: true, value: await p };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function isRpcError(o: unknown, code: number): boolean {
    return typeof o === "object" && o !== null && (o as { code?: unknown }).code === code;
  }

  /** Standard happy-path fake: tag img:1 resolving to digest aaaa/config bbbb. */
  const HAPPY_FAKE = {
    FAKE_IMAGE_TAG: "img:1",
    FAKE_IMAGE_DIGEST: "sha256:aaaa",
    FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbb",
  };

  it("admission resolves+validates an identity WITHOUT create, disposes its owned transport, then the persisted pin drives the first create", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    const identity = await c.resolveAndAdmitIdentity();
    assert.deepEqual(identity, pin(), "admission returns the validated content+config identity");
    assert.equal(c.pinnedImageIdentity, null, "admission must NOT pin; the caller persists the returned pin");
    assert.equal(c.rpcRunning, false, "admission's owned transport must be disposed before returning");

    // Wire journal: admission ONLY resolved — no create was ever issued.
    let txn = s.readTranscript();
    assert.deepEqual(transcriptMethods(txn), ["resolve_image"], "admission may only resolve_image");
    assert.equal(transcriptMethodIndexes(txn, "create").length, 0);

    // Persist (simulated) then first create with the persisted pin.
    const { vmId, identity: sent } = await c.prepareAndCreate(identity);
    assert.match(vmId, /^vm-/);
    assert.deepEqual(sent, pin());
    assert.equal(c.identity.vmId, vmId);
    assert.deepEqual(c.pinnedImageIdentity, pin());
    assert.equal(c.rpcRunning, true, "the create invocation runs its own fresh owned RPC child");

    txn = s.readTranscript();
    assert.deepEqual(
      transcriptMethods(txn),
      ["resolve_image", "resolve_image", "create"],
      "second transport: re-resolve + create; the create carries the persisted pin",
    );
    const createParams = txn[transcriptMethodIndexes(txn, "create")[0]].params as Record<string, unknown>;
    assert.deepEqual(createParams.image_identity, pin(), "create.image_identity is the persisted EXPECTED pin");

    await c.close(30);
    const outcome = await c.dispose();
    assert.equal(outcome.code, 0, "fake RPC child exits cleanly after a confirmed close");
  });

  it("admission failure (resolve error) still disposes its owned transport and NEVER creates", async (t) => {
    const s = testScaffold(t);
    s.setFake({ FAKE_IMAGE_TAG: "img:1", FAKE_RESOLVE_MISSING: "1" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await assert.rejects(
      () => c.resolveAndAdmitIdentity(),
      (e: unknown) => rpcCodeOf(e) === -32602,
    );
    assert.equal(c.rpcRunning, false, "owned transport must be disposed on admission failure");
    assert.equal(c.lifecycle, "open", "admission failure must not close/dispose the controller itself");
    const txn = s.readTranscript();
    assert.equal(transcriptMethodIndexes(txn, "create").length, 0, "a failed admission never creates");
  });

  it("a HANGING resolve during admission is a bounded REPORTED failure that disposes its owned transport and never creates", async (t) => {
    const s = testScaffold(t);
    // The driver never answers resolve_image: the admission seam must NOT hang
    // — its bounded owned transport reports the deadline and is disposed, and
    // no create can ever be issued from an admission that never resolved.
    s.setFake({ ...HAPPY_FAKE, FAKE_RESOLVE_HANG: "1" });
    const c = s.makeController(policy({ configurationRoot: configDir }), { requestTimeoutMs: 500 });
    const started = Date.now();
    await assert.rejects(
      () => c.resolveAndAdmitIdentity(),
      (e: unknown) => rpcCodeOf(e) === MATCHLOCK_CLIENT_ERROR_CODES.TIMEOUT,
    );
    assert.ok(Date.now() - started < 5_000, "the admission resolve deadline must fire promptly (bounded, never a hang)");
    assert.equal(c.rpcRunning, false, "the admission's OWNED transport must be disposed on a bounded resolve timeout");
    assert.equal(c.lifecycle, "open", "a failed admission must not close/dispose the controller itself");
    const txn = s.readTranscript();
    assert.deepEqual(transcriptMethods(txn), ["resolve_image"], "admission sends only resolve_image");
    assert.equal(transcriptMethodIndexes(txn, "create").length, 0, "a hanging admission never reaches create");
    assert.equal(txn.filter((e) => e.event === "vm_created").length, 0, "no VM was ever created");
  });

  it("prepareAndCreate REQUIRES the persisted pin: undefined/null/no-arg fail BEFORE spawn and never reach create", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    // A plain JS-style call with NO argument must fail at runtime, not create.
    const jsCaller = c as unknown as { prepareAndCreate(): Promise<unknown> };
    await assert.rejects(
      () => jsCaller.prepareAndCreate(),
      (e: unknown) => codeOf(e) === "image_identity_required",
    );
    await assert.rejects(
      () => c.prepareAndCreate(undefined as unknown as PinnedImageIdentity),
      (e: unknown) => codeOf(e) === "image_identity_required",
    );
    await assert.rejects(
      () => c.prepareAndCreate(null as unknown as PinnedImageIdentity),
      (e: unknown) => codeOf(e) === "image_identity_required",
    );
    assert.equal(c.rpcRunning, false, "a missing pin must fail BEFORE spawning any RPC child");
    assert.equal(c.lifecycle, "open");
    assert.equal(s.readTranscript().length, 0, "no wire traffic at all for a missing pin");

    // The pre-spawn validation did NOT consume the single-shot invocation:
    // a corrected call on the SAME instance still creates.
    const { vmId } = await c.prepareAndCreate(pin());
    assert.match(vmId, /^vm-/);
  });

  it("an empty or partial persisted expected identity fails closed BEFORE spawn", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await assert.rejects(
      () => c.prepareAndCreate({ digest: "", config_digest: "", tag: "img:1" }),
      (e: unknown) => codeOf(e) === "image_unusable",
    );
    // A pin with content but NO config digest must be refused too (content AND
    // config are both required — never a digest-only stand-in).
    await assert.rejects(
      () => c.prepareAndCreate({ digest: "sha256:aaaa", config_digest: "", tag: "img:1" }),
      (e: unknown) => codeOf(e) === "image_unusable",
    );
    assert.equal(c.rpcRunning, false);
    assert.equal(s.readTranscript().length, 0, "invalid pins fail before any child spawn / wire traffic");
  });

  it("a moved/repinned image (content AND config changed) is rejected BEFORE create with owned-child cleanup", async (t) => {
    const s = testScaffold(t);
    s.setFake({
      FAKE_IMAGE_TAG: "img:1",
      FAKE_IMAGE_DIGEST: "sha256:MOVED",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:MOVED-CONFIG",
    });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    const expected = { digest: "sha256:PINNED", config_digest: "sha256:PINNED-CONFIG", tag: "img:1" };
    await assert.rejects(
      () => c.prepareAndCreate(expected),
      (e: unknown) => codeOf(e) === "image_identity_mismatch",
    );
    const txn = s.readTranscript();
    assert.equal(txn.length, 1, "only resolve_image may reach the wire");
    assert.equal(txn[0].method, "resolve_image");
    assert.equal(transcriptMethodIndexes(txn, "create").length, 0, "moved tag must NEVER send create");
    // Post-start failure cleanup: the single-shot controller disposed its
    // OWNED RPC child before propagating the rejection, so a moved-tag retry
    // loop cannot leak one idle `matchlock rpc` child per failed attempt.
    assert.equal(c.rpcRunning, false, "owned RPC child must be disposed after a post-start failure");
  });

  it("a CHANGED CONTENT (digest) with matching config is refused BEFORE create", async (t) => {
    const s = testScaffold(t);
    s.setFake({ FAKE_IMAGE_TAG: "img:1", FAKE_IMAGE_DIGEST: "sha256:CHANGED-CONTENT", FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbb" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (e: unknown) => codeOf(e) === "image_identity_mismatch",
    );
    const txn = s.readTranscript();
    assert.deepEqual(transcriptMethods(txn), ["resolve_image"], "changed content must never reach create");
    assert.equal(c.rpcRunning, false);
  });

  it("a CHANGED CONFIG (config_digest) with matching content is refused BEFORE create", async (t) => {
    const s = testScaffold(t);
    s.setFake({ FAKE_IMAGE_TAG: "img:1", FAKE_IMAGE_DIGEST: "sha256:aaaa", FAKE_IMAGE_CONFIG_DIGEST: "sha256:CHANGED-CONFIG" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (e: unknown) => codeOf(e) === "image_identity_mismatch",
    );
    const txn = s.readTranscript();
    assert.deepEqual(transcriptMethods(txn), ["resolve_image"], "changed config must never reach create");
    assert.equal(c.rpcRunning, false);
  });

  it("a MOVED TAG with identical content is refused BEFORE create (no silent repin of the tag)", async (t) => {
    const s = testScaffold(t);
    s.setFake({ FAKE_IMAGE_TAG: "img:2", FAKE_IMAGE_DIGEST: "sha256:aaaa", FAKE_IMAGE_CONFIG_DIGEST: "sha256:bbbb" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await assert.rejects(
      () => c.prepareAndCreate(pin("sha256:aaaa", "sha256:bbbb", "img:1")),
      (e: unknown) => codeOf(e) === "image_identity_mismatch" && /tag mismatch/.test((e as Error).message),
    );
    const txn = s.readTranscript();
    assert.deepEqual(transcriptMethods(txn), ["resolve_image"], "a moved tag must never reach create");
    assert.equal(c.rpcRunning, false);
  });

  it("an explicit valid first pin creates a fresh VM and sends the exact-destination mount plan with the EXPECTED identity", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    const { vmId, identity } = await c.prepareAndCreate(pin());
    assert.match(vmId, /^vm-/);
    assert.deepEqual(identity, pin());
    assert.equal(c.identity.vmId, vmId);
    assert.deepEqual(c.pinnedImageIdentity, pin());
    assert.equal(c.rpcRunning, true, "owned RPC child should be running after create");

    const txn = s.readTranscript();
    assert.equal(txn[0].method, "resolve_image");
    assert.equal((txn[0].params as Record<string, unknown>).tag, "img:1");
    assert.equal(txn[1].method, "create");
    const createParams = txn[1].params as Record<string, unknown>;
    assert.deepEqual(createParams.image_identity, pin(), "create.image_identity is the persisted EXPECTED pin, never a re-pin");
    const vfs = createParams.vfs as Record<string, unknown>;
    assert.equal(vfs.exact_destinations, true);
    const mounts = vfs.mounts as Record<string, { type: string; readonly?: boolean; host_path?: string }>;
    assert.equal(mounts["/opt/project"].host_path, "/opt/project");
    assert.equal(mounts["/opt/project"].type, "host_fs");
    assert.equal(mounts["/opt/project"].readonly, false);
    // The nested /opt/project/.git git-metadata destination is dropped before
    // create (same host source under the /opt/project mount; the runtime
    // rejects nested destinations).
    assert.equal(mounts["/opt/project/.git"], undefined, "nested same-source .git must not reach create");
    assert.equal(mounts["/workspace/config/pi"].host_path, configDir);
    assert.equal(mounts["/workspace/runtime"].readonly, true);
    assert.equal(mounts["/workspace/runtime"].host_path, helperPack);
    assert.equal((createParams.env as Record<string, string>).PI_CODING_AGENT_DIR, "/workspace/config/pi");
  });

  it("exec_pipe: streams stdout and stderr separately, honors stdin + EOF, frames decode exactly once", async (t) => {
    const s = testScaffold(t);
    s.setFake({
      ...HAPPY_FAKE,
      FAKE_ECHO_STDIN: "1",
      FAKE_EXEC_STDERR: "boom",
      FAKE_EXEC_EXIT: "7",
    });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    const stdout: MatchlockStreamFrame[] = [];
    const stderr: MatchlockStreamFrame[] = [];
    const pipe = c.execPipe({ command: "cat" }, (f: MatchlockStreamFrame) => {
      if (f.kind === "stdout") stdout.push(f);
      if (f.kind === "stderr") stderr.push(f);
    });
    await pipe.stdin.write("hello\n");
    await pipe.stdin.eof();
    const result = await pipe.result;
    assert.equal(result.exit_code, 7);
    assert.equal(decodeFramesText(stdout), "hello\n");
    assert.equal(decodeFramesText(stderr), "boom");
  });

  it("cancel cancels an in-flight exec and the request rejects with ErrCodeCancelled", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    const pipe = c.execPipe({ command: "sleep" }, () => {});
    const outcome = settle(pipe.result);
    const cancelled = await c.cancel(pipe.requestId);
    assert.equal(cancelled, true);
    const o = await outcome;
    assert.equal(o.ok, false, "cancelled exec must reject, not resolve");
    if (!o.ok) assert.equal(isRpcError(o.error, -32003), true, "exec must reject with ErrCodeCancelled");
  });

  it("close(0) is rejected BEFORE any state mutation: work stays admitted and a later close(30) still reaches the wire", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    await assert.rejects(() => c.close(0), /positive timeout_seconds/);
    assert.equal(c.isClosed, false, "rejected close(0) must NOT mark the controller closed");
    assert.equal(c.lifecycle, "open", "rejected close(0) must NOT revoke guest-work admission");
    assert.equal(c.rpcRunning, true, "RPC child must still be alive after a rejected close");

    // A rejected invalid close must NOT have revoked work: a new exec is still
    // admitted and reaches the wire.
    const r = await c.execStream({ command: "echo ok" }, () => {});
    assert.equal(r.exit_code, 0);

    // The subsequent valid close must actually send a close request (the
    // pre-fix code silently no-op'ed it because closed=true was set early).
    await c.close(30);
    assert.equal(c.isClosed, true);
    assert.equal(c.lifecycle, "closed");
    const txn = s.readTranscript();
    const closeIdx = transcriptMethodIndexes(txn, "close");
    assert.ok(closeIdx.length === 1, `expected exactly one close on the wire, got ${closeIdx.length}`);
    const closeParams = txn[closeIdx[0]].params as Record<string, unknown>;
    assert.equal(closeParams.timeout_seconds, 30);
    const outcome = await c.dispose();
    assert.equal(outcome.code, 0, "fake RPC child should exit 0 after a confirmed close");
  });

  it("a DELAYED close revokes NEW guest work BEFORE cancellation: both exec methods denied while close is in flight", async (t) => {
    const s = testScaffold(t);
    s.setFake({
      ...HAPPY_FAKE,
      FAKE_PIPE_WAIT_MS: "30000", // the live pipe stays in flight until cancelled
      FAKE_CLOSE_DELAY_MS: "700", // close response is held so admission stays revoked
    });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    // A live exec that must be cancelled/settled before the (delayed) close.
    const live = c.execPipe({ command: "sleep" }, () => {});
    const liveOutcome = settle(live.result);

    const closing = c.close(30);
    // Admission is revoked SYNCHRONOUSLY with the valid close request — these
    // are attempted while close is in flight (before it is confirmed).
    await assert.rejects(
      () => c.execStream({ command: "late-stream" }, () => {}),
      (e: unknown) => codeOf(e) === "controller_closing",
    );
    assert.throws(
      () => c.execPipe({ command: "late-pipe" }, () => {}),
      (e: unknown) => codeOf(e) === "controller_closing",
    );
    assert.equal(c.lifecycle, "closing");

    await closing;
    assert.equal(c.isClosed, true);
    assert.equal(c.lifecycle, "closed");
    const o = await liveOutcome;
    assert.equal(o.ok, false, "the live exec must be cancelled/settled before close");
    if (!o.ok) assert.equal(isRpcError(o.error, -32003), true, "live exec must reject with ErrCodeCancelled");

    const txn = s.readTranscript();
    // The denied late execs NEVER reached the wire — only the original live
    // exec_pipe was ever sent, and cancel precedes the single close.
    assert.equal(transcriptMethodIndexes(txn, "exec_stream").length, 0, "denied exec_stream must never hit the wire");
    assert.equal(transcriptMethodIndexes(txn, "exec_pipe").length, 1, "only the pre-close live exec_pipe reaches the wire");
    const cancelIdx = transcriptMethodIndexes(txn, "cancel");
    const closeIdx = transcriptMethodIndexes(txn, "close");
    assert.ok(cancelIdx.length >= 1, "expected cancel(s) before close");
    assert.ok(closeIdx.length === 1, "expected exactly one close");
    assert.ok(cancelIdx[0] < closeIdx[0], "cancel must be sent before close");
    const result = await c.dispose();
    assert.equal(result.code, 0);
  });

  it("dispose while a DELAYED close is in flight: the close promise rejects cleanly (bounded), lifecycle lands disposed, dispose stays idempotent", async (t) => {
    const s = testScaffold(t);
    // The close response is held 800 ms so dispose() provably races an
    // in-flight (unconfirmed) close — pinning the closing/dispose teardown
    // race requirement 2 governs: no hung close promise, no reopened work.
    s.setFake({ ...HAPPY_FAKE, FAKE_CLOSE_DELAY_MS: "800" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());

    const started = Date.now();
    const closing = settle(c.close(30));
    // Wait (bounded) until the close request is ON THE WIRE and still awaiting
    // its delayed response — dispose must interrupt an in-flight close.
    const pollDeadline = Date.now() + 2_000;
    while (transcriptMethodIndexes(s.readTranscript(), "close").length === 0 && Date.now() < pollDeadline) {
      await delay(10);
    }
    assert.ok(
      transcriptMethodIndexes(s.readTranscript(), "close").length === 1,
      "the close request must reach the wire before dispose races it",
    );
    assert.equal(c.lifecycle, "closing", "admission is revoked while close is in flight");

    // Dispose while close is awaiting its (delayed) response: the in-flight
    // close must REJECT cleanly (bounded, never a hung close promise) because
    // the owned transport is disposed underneath it.
    const racedDispose = settle(c.dispose());
    const o = await closing;
    assert.equal(o.ok, false, "an in-flight close interrupted by dispose must reject, not hang");
    if (!o.ok) {
      assert.equal(
        isRpcError(o.error, MATCHLOCK_CLIENT_ERROR_CODES.DISPOSED),
        true,
        "the interrupted close must reject with the client DISPOSED error (bounded, reported)",
      );
    }
    assert.ok(Date.now() - started < 5_000, "close+dispose must settle promptly (no hang)");

    const d = await racedDispose;
    assert.equal(d.ok, true, "dispose must resolve");
    const outcome = d.ok ? d.value : null;
    assert.ok(
      outcome !== null && (outcome.code === 0 || (outcome.code === null && outcome.signal === "SIGTERM")),
      `dispose must observe a real owned-child exit (got ${JSON.stringify(outcome)})`,
    );
    assert.equal(c.lifecycle, "disposed", "lifecycle must end disposed (never closed: close was not confirmed)");
    assert.equal(c.isClosed, false, "an interrupted close was never CONFIRMED, so isClosed stays false");
    assert.deepEqual(c.rpcExit, outcome, "rpcExit forensics match the observed owned-child exit");

    // Dispose stays idempotent and admission stays revoked for good.
    const again = await c.dispose();
    assert.deepEqual(again, outcome, "dispose must be idempotent");
    await assert.rejects(
      () => c.execStream({ command: "x" }, () => {}),
      (e: unknown) => codeOf(e) === "controller_disposed",
    );
    assert.throws(() => c.execPipe({ command: "x" }, () => {}), (e: unknown) => codeOf(e) === "controller_disposed");
    await assert.rejects(() => c.close(30), (e: unknown) => codeOf(e) === "controller_disposed");

    const txn = s.readTranscript();
    // Exactly one close ever reached the wire (no retry fabricated on a dead
    // transport) and no denied exec was ever sent.
    assert.equal(transcriptMethodIndexes(txn, "close").length, 1, "exactly one close frame (disposed before the delayed response)");
    assert.equal(transcriptMethodIndexes(txn, "exec_stream").length, 0, "no exec_stream frame after dispose");
    assert.equal(transcriptMethodIndexes(txn, "exec_pipe").length, 0, "no exec_pipe frame after dispose");
  });

  it("a FAILED close revokes new guest work permanently, yet a later close retry is allowed and never reopens admission", async (t) => {
    const s = testScaffold(t);
    s.setFake({ ...HAPPY_FAKE, FAKE_CLOSE_FAIL: "1" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());

    // First close is refused by the server (-32000) — the close was NOT
    // confirmed, so isClosed stays false.
    await assert.rejects(
      () => c.close(30),
      (e: unknown) => rpcCodeOf(e) === -32000 && /close failed/.test((e as Error).message),
    );
    assert.equal(c.isClosed, false);
    assert.equal(c.lifecycle, "closing", "admission stays REVOKED after a failed close");

    // The failed close must NOT reopen guest work: both exec methods denied.
    await assert.rejects(
      () => c.execStream({ command: "late" }, () => {}),
      (e: unknown) => codeOf(e) === "controller_closing",
    );
    assert.throws(
      () => c.execPipe({ command: "late" }, () => {}),
      (e: unknown) => codeOf(e) === "controller_closing",
    );

    // Retry cleanup is allowed (the failure did not brick close forever): the
    // fixture fails exactly once, so this second close is confirmed.
    await c.close(30);
    assert.equal(c.isClosed, true);
    assert.equal(c.lifecycle, "closed");
    const txn = s.readTranscript();
    assert.equal(transcriptMethodIndexes(txn, "close").length, 2, "first (failed) + second (confirmed) close on the wire");
    assert.equal(transcriptMethodIndexes(txn, "exec_stream").length, 0, "no denied exec ever reached the wire");
    assert.equal(transcriptMethodIndexes(txn, "exec_pipe").length, 0, "no denied exec ever reached the wire");
    const result = await c.dispose();
    assert.equal(result.code, 0);
  });

  // ── MTLK-CLEANUP US-004: idempotent already-stopped close ────────────────

  it("US-004: a close response naming an already-stopped VM resolves the controller as CLOSED and is a no-op when repeated", async (t) => {
    const s = testScaffold(t);
    // Server rejects close with the benign "vm not running" body (the VM is
    // already gone: the guest exited / a previous close ran).
    s.setFake({ ...HAPPY_FAKE, FAKE_CLOSE_ERROR_MESSAGE: "vm not running" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());

    // A confirmed (already-stopped) close must NOT surface as a cleanup
    // failure: it resolves and marks the controller closed.
    await c.close(30);
    assert.equal(c.isClosed, true, "an already-stopped close body is a CONFIRMED close");
    assert.equal(c.lifecycle, "closed", "lifecycle reaches closed, not closing");
    assert.equal(c.rpcRunning, false, "the owned child is reclaimed after the confirmed close");

    // Calling close twice on an already-closed controller is a no-op: no new
    // wire frame and never a throw.
    const framesBefore = s.readTranscript().length;
    await c.close(30);
    assert.equal(s.readTranscript().length, framesBefore, "a repeated close on a closed controller must not reach the wire");
    assert.equal(c.isClosed, true);

    const txn = s.readTranscript();
    assert.equal(transcriptMethodIndexes(txn, "close").length, 1, "exactly one close frame (the repeated close was a no-op)");
    const out = await c.dispose();
    assert.equal(out.code, 0);
  });

  it("US-004: a close with NO live transport still throws matchlock_cleanup_failed and never fabricates isClosed", async (t) => {
    const s = testScaffold(t);
    s.setFake({ ...HAPPY_FAKE, FAKE_EXIT_AFTER_CREATE_MS: "200" });
    const c = s.makeController(policy({ configurationRoot: configDir }), { requestTimeoutMs: 1500 });
    await c.prepareAndCreate(pin());
    // The fixture exits (code 9) shortly after create with NO close response.
    const deadline = Date.now() + 5_000;
    while (c.rpcRunning && Date.now() < deadline) await delay(20);
    assert.equal(c.rpcRunning, false, "the owned child must have exited");
    // No wire response exists to confirm a close — the already-stopped
    // recognition must NOT apply to a dead transport.
    await assert.rejects(() => c.close(30), (e: unknown) => codeOf(e) === "matchlock_cleanup_failed");
    assert.equal(c.isClosed, false, "a dead transport never fabricates a confirmed close");
    assert.equal(c.lifecycle, "closing", "the close barrier stays revoked and retryable");
    const out = await c.dispose();
    assert.deepEqual(out, { code: 9, signal: null });
  });

  it("post-close and post-dispose guest work is denied; dispose is idempotent; close after dispose is rejected", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    await c.close(30);
    assert.equal(c.isClosed, true);

    // Confirmed close: no new exec may enter.
    await assert.rejects(
      () => c.execStream({ command: "x" }, () => {}),
      (e: unknown) => codeOf(e) === "controller_closed",
    );
    assert.throws(() => c.execPipe({ command: "x" }, () => {}), (e: unknown) => codeOf(e) === "controller_closed");
    // A repeated close is an idempotent no-op (no second close frame).
    const framesBefore = s.readTranscript().length;
    await c.close(30);
    assert.equal(s.readTranscript().length, framesBefore);

    // Dispose remains available and idempotent after a confirmed close.
    const out1 = await c.dispose();
    assert.equal(out1.code, 0);
    assert.equal(c.lifecycle, "disposed");
    await assert.rejects(
      () => c.execStream({ command: "x" }, () => {}),
      (e: unknown) => codeOf(e) === "controller_disposed",
    );
    assert.throws(() => c.execPipe({ command: "x" }, () => {}), (e: unknown) => codeOf(e) === "controller_disposed");
    const out2 = await c.dispose();
    assert.deepEqual(out2, out1, "dispose must be idempotent");
    // The VM close was already CONFIRMED before dispose, so a further close is
    // an idempotent no-op (no new close frame, no error).
    const frames = s.readTranscript().length;
    await c.close(30);
    assert.equal(s.readTranscript().length, frames, "close after a confirmed close+dispose is a no-op");
  });

  it("dispose WITHOUT a confirmed close revokes work immediately, denies a later close, and stays idempotent", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    // Dispose without ever closing: isClosed must stay false (no VM-close
    // confirmation happened) while guest work is revoked immediately. The
    // owned child's observed exit is a REAL exit — either stdin-EOF normal
    // exit (code 0) or the exact-owned SIGTERM dispose kill (never a guess).
    const outcome = await c.dispose();
    assert.ok(
      outcome.code === 0 || (outcome.code === null && outcome.signal === "SIGTERM"),
      `dispose must observe a real owned-child exit (got ${JSON.stringify(outcome)})`,
    );
    assert.equal(c.isClosed, false, "dispose alone is NOT a confirmed VM close");
    assert.equal(c.lifecycle, "disposed");
    await assert.rejects(
      () => c.execStream({ command: "x" }, () => {}),
      (e: unknown) => codeOf(e) === "controller_disposed",
    );
    assert.throws(() => c.execPipe({ command: "x" }, () => {}), (e: unknown) => codeOf(e) === "controller_disposed");
    // A close cannot be requested on a disposed controller.
    await assert.rejects(() => c.close(30), (e: unknown) => codeOf(e) === "controller_disposed");
    const again = await c.dispose();
    assert.deepEqual(again, outcome, "dispose must be idempotent");
  });

  it("an RPC child exit alone is NOT a confirmed VM close: isClosed stays false, close cannot be fabricated, exec fails reported", async (t) => {
    const s = testScaffold(t);
    s.setFake({ ...HAPPY_FAKE, FAKE_EXIT_AFTER_CREATE_MS: "250" });
    const c = s.makeController(policy({ configurationRoot: configDir }), { requestTimeoutMs: 1500 });
    await c.prepareAndCreate(pin());
    // The fixture exits itself (code 9) shortly after create, with NO close
    // request — wait (bounded) for the owned child to exit.
    const deadline = Date.now() + 5_000;
    while (c.rpcRunning && Date.now() < deadline) await delay(20);
    assert.equal(c.rpcRunning, false, "fixture child must exit on its own");
    assert.equal(c.isClosed, false, "transport exit alone must NEVER mark the controller closed");
    assert.equal(c.lifecycle, "open", "admission gate is not 'closed' merely because the child exited");
    assert.deepEqual(c.rpcExit, { code: 9, signal: null }, "the REAL child exit code is exposed for forensics");

    // New work on the dead transport is a REPORTED failure (never a hang).
    const o = await settle(c.execStream({ command: "x" }, () => {}));
    assert.equal(o.ok, false, "exec on a dead transport must reject, not hang");

    // A close cannot be CONFIRMED without a live transport; it fails loudly
    // and still never sets isClosed.
    await assert.rejects(() => c.close(30), (e: unknown) => codeOf(e) === "matchlock_cleanup_failed");
    assert.equal(c.isClosed, false);
    assert.equal(c.lifecycle, "closing");
    const result = await c.dispose();
    assert.deepEqual(result, { code: 9, signal: null });
    assert.equal(c.lifecycle, "disposed");
  });

  it("rpcExit exposes the REAL signal of a signaled owned child (never a success-shaped record)", async (t) => {
    const s = testScaffold(t);
    // FAKE_HOLD_OPEN: the fixture stays alive on stdin EOF so dispose() must
    // SIGTERM the EXACT owned child — its true exit signal is observable.
    s.setFake({ ...HAPPY_FAKE, FAKE_HOLD_OPEN: "1" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    const outcome = await c.dispose();
    assert.equal(outcome.signal, "SIGTERM", "dispose must report the real signal of the owned child");
    assert.equal(outcome.code, null);
    assert.deepEqual(c.rpcExit, { code: null, signal: "SIGTERM" }, "rpcExit must carry the real signal, not signal:null");
    assert.equal(c.isClosed, false, "a killed transport is not a confirmed VM close");
    assert.equal(c.lifecycle, "disposed");
    await assert.rejects(
      () => c.execStream({ command: "x" }, () => {}),
      (e: unknown) => codeOf(e) === "controller_disposed",
    );
  });

  it("rpcExit reports the actual owned child exit (code 0, signal null) after a confirmed normal close", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    await c.close(30);
    assert.equal(c.isClosed, true);
    assert.deepEqual(c.rpcExit, { code: 0, signal: null }, "a normal exit is code 0 with a null signal");
  });

  it("close cancels and settles a live exec before closing (server close waits handlers)", async (t) => {
    const s = testScaffold(t);
    s.setFake({ ...HAPPY_FAKE, FAKE_PIPE_WAIT_MS: "30000" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    const pipe = c.execPipe({ command: "sleep" }, () => {});
    const outcome = settle(pipe.result);
    await c.close(30);
    assert.equal(c.isClosed, true);
    const o = await outcome;
    assert.equal(o.ok, false, "the live exec must be cancelled/settled before close");
    if (!o.ok) assert.equal(isRpcError(o.error, -32003), true, "exec must reject with ErrCodeCancelled");
    const txn = s.readTranscript();
    const cancelIdx = transcriptMethodIndexes(txn, "cancel");
    const closeIdx = transcriptMethodIndexes(txn, "close");
    assert.ok(cancelIdx.length >= 1, "expected cancel(s) before close");
    assert.ok(closeIdx.length === 1, "expected exactly one close");
    assert.ok(cancelIdx[0] < closeIdx[0], "cancel must be sent before close");
    const result = await c.dispose();
    assert.equal(result.code, 0);
  });

  it("create with a mismatched ACTUAL built image_identity fails closed at the runtime boundary with child cleanup", async (t) => {
    const s = testScaffold(t);
    // Store identity (resolve_image) differs from the ACTUAL built image the
    // runtime verifies create.image_identity against -> create rejects.
    s.setFake({
      FAKE_IMAGE_TAG: "img:1",
      FAKE_IMAGE_DIGEST: "sha256:STORE",
      FAKE_IMAGE_CONFIG_DIGEST: "sha256:STORE",
      FAKE_CREATE_ACTUAL_DIGEST: "sha256:ACTUAL",
      FAKE_CREATE_ACTUAL_CONFIG_DIGEST: "sha256:ACTUAL",
      FAKE_CREATE_REJECT_IMAGE_IDENTITY: "1",
    });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await assert.rejects(
      () => c.prepareAndCreate(pin("sha256:STORE", "sha256:STORE", "img:1")),
      (e: unknown) => {
        const err = e as { code?: number; message?: string };
        return err.code === -32000 && /identity mismatch/.test(err.message ?? "");
      },
    );
    assert.equal(c.rpcRunning, false, "owned RPC child must be disposed after the runtime-boundary rejection");
    assert.equal(c.identity.vmId, null);
  });

  it("a controller instance invokes exactly once (fresh VM per invocation)", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    const t1 = s.readTranscript().length;
    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (e: unknown) => codeOf(e) === "controller_already_invoked",
    );
    assert.equal(s.readTranscript().length, t1, "a second create must never reach the wire");
  });

  it("create has its OWN bounded deadline and a hang is a REPORTED failure with child cleanup", async (t) => {
    const s = testScaffold(t);
    // The driver never answers create (cold-boot hang simulation).
    s.setFake({ ...HAPPY_FAKE, FAKE_CREATE_HANG: "1" });
    // A distinct, bounded create budget (a cold VM boot / image pull can
    // exceed the shared requestTimeoutMs default).
    const c = s.makeController(policy({ configurationRoot: configDir }), { createTimeoutMs: 500 });
    const started = Date.now();
    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (e: unknown) => rpcCodeOf(e) === MATCHLOCK_CLIENT_ERROR_CODES.TIMEOUT,
    );
    assert.ok(Date.now() - started < 5_000, "create deadline must fire promptly");
    assert.equal(c.rpcRunning, false, "owned RPC child must be disposed after the failed create");
    assert.equal(c.identity.vmId, null);
  });

  it("close uses the fake driver's faithful close semantics (server does not validate the timeout)", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    await c.close(5);
    assert.equal(c.isClosed, true);
    const txn = s.readTranscript();
    const closeParams = txn[transcriptMethodIndexes(txn, "close")[0]].params as Record<string, unknown>;
    assert.equal(closeParams.timeout_seconds, 5);
    const outcome = await c.dispose();
    assert.equal(outcome.code, 0, "fake RPC child exits cleanly after stdin close following a confirmed close");
  });

  // ── DSH-PROFILE-OVERLAY US-002: per-invocation private overlay lifecycle ──
  // The controller prepares the private dsh profile overlay BEFORE create,
  // forwards it into the composed mount plan (ONE private profiles/ destination
  // plus host-mapped durable top-level entries), and removes exactly the
  // attested per-run root after the VM close is confirmed on the wire.

  function makeDshHomeFixture(prefix: string): string {
    const home = fs.mkdtempSync(path.join(tmp, prefix));
    fs.mkdirSync(path.join(home, "profiles", "headless", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(home, "profiles", "headless", ".dsh-module-fallback", "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(home, "sessions"), { recursive: true });
    fs.writeFileSync(path.join(home, ".credentials.yaml"), "refs: []\n", "utf8");
    return home;
  }

  it("dsh create prepares the private overlay, mounts ONE real effective-home root from it, and removes the attested root after the confirmed close", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const runId = "11111111-2222-3333-4444-555555555555";
    const dshHome = makeDshHomeFixture("dsh-home-");
    const liveState = fs.mkdtempSync(path.join(tmp, "live-state-"));
    const overlayRoot = dshProfileOverlayRoot(runId, liveState);
    const p = dshPolicy({ configurationRoot: dshHome });
    const c = new MatchlockController(p, {
      rpcBinaryPath: process.execPath,
      rpcArgs: [fakeDriver],
      helperPackHostPath: helperPack,
      requestTimeoutMs: 10_000,
      readyTimeoutMs: 3_000,
      stdinDrainTimeoutMs: 3_000,
      execCancelSettleTimeoutMs: 3_000,
      dshProfileOverlay: { runId, liveStateRoot: liveState },
      mountAdmission: { home: path.join(tmp, "operator-home"), liveStateRoot: liveState },
    });
    t.after(() => c.dispose());

    assert.equal(fs.existsSync(overlayRoot), false, "no overlay exists before the invocation");

    await c.prepareAndCreate(pin());
    // prepareDshProfileOverlay ran BEFORE create: the private dir exists now.
    const derivedOverlayDir = path.join(overlayRoot, "profiles", "headless", "node_modules");
    assert.ok(fs.existsSync(derivedOverlayDir), "the private overlay dir must exist before/at create");
    assert.ok(fs.lstatSync(derivedOverlayDir).isDirectory(), "the overlay dir is a real directory");

    const txn = s.readTranscript();
    const createIdx = transcriptMethodIndexes(txn, "create");
    assert.equal(createIdx.length, 1, "exactly one create reached the wire");
    const createParams = txn[createIdx[0]].params as Record<string, unknown>;
    const mounts = (createParams.vfs as Record<string, unknown>).mounts as Record<
      string,
      { type?: string; host_path?: string; readonly?: boolean }
    >;
    // ONE real effective-home root from the private overlay (never the host
    // home): the home root is host-backed, so the run-#35 fsync target has a
    // real provider, while profiles/ stays the private staged copy.
    assert.equal(
      mounts["/workspace/config/dsh"].host_path,
      overlayRoot,
      "the effective home root is sourced from the private overlay",
    );
    assert.equal(mounts["/workspace/config/dsh"].type, "host_fs");
    assert.equal(mounts["/workspace/config/dsh"].readonly, false);
    assert.notEqual(mounts["/workspace/config/dsh"].host_path, dshHome, "the host DSH_HOME is never mounted");
    assert.equal(
      mounts["/workspace/config/dsh/profiles"],
      undefined,
      "the effective home is the single destination (no nested profiles destination)",
    );
    assert.equal(
      mounts["/workspace/config/dsh/profiles/headless/node_modules"],
      undefined,
      "no per-child profile destination may exist",
    );
    // The effective home stages each durable top-level entry at <DSH_HOME>/<entry>.
    for (const rel of [".credentials.yaml", "sessions"]) {
      assert.equal(
        fs.existsSync(path.join(overlayRoot, rel)),
        true,
        `${rel} must be staged in the effective home`,
      );
    }

    await c.close(30);
    assert.equal(c.isClosed, true);
    assert.equal(
      fs.existsSync(overlayRoot),
      false,
      "the attested per-run overlay root must be removed after the confirmed VM close",
    );
  });

  it("dsh create with NO host-attested overlay option is refused by the mount plan and never reaches create", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const dshHome = makeDshHomeFixture("dsh-home-noverlay-");
    const c = s.makeController(dshPolicy({ configurationRoot: dshHome }));
    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (e: unknown) => codeOf(e) === "dsh_profile_overlay_required",
    );
    const txn = s.readTranscript();
    assert.equal(transcriptMethodIndexes(txn, "create").length, 0, "a dsh plan with no overlay never issues create");
  });

  // ── MTLK-CTRL-PHASE lifecycle/admission/create race regressions ──────────
  // Root's actual-module probe (controller-admission-lifecycle-probe.mjs)
  // recorded close(1) BEFORE create leaving lifecycle=closing and then
  // prepareAndCreate(validPin) SUCCEEDING (start/resolve/CREATE). The
  // controller now requires lifecycle OPEN at admission/create entry and
  // re-checks OPEN after the awaited resolve before CREATE; these tests pin
  // that with owned fake-RPC wire journals.

  it("a valid close BEFORE the first admission/create permanently bars work even though cleanup failed (no transport existed): no child is spawned, no frame reaches the wire", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const c = s.makeController(policy({ configurationRoot: configDir }));
    // close(1) on a controller that never started a transport cannot confirm
    // a VM close (nothing ever existed): cleanup fails, lifecycle stays
    // permanently 'closing'.
    await assert.rejects(
      () => c.close(1),
      (e: unknown) => codeOf(e) === "matchlock_cleanup_failed",
    );
    assert.equal(c.lifecycle, "closing", "the valid close permanently revokes work");
    assert.equal(c.isClosed, false, "no close was ever confirmed on the wire");
    assert.equal(c.rpcRunning, false, "no transport was ever spawned");

    // closing never reopens: BOTH admission and create are barred (this is the
    // exact root-probe case — prepareAndCreate must NOT start/resolve/create).
    await assert.rejects(
      () => c.resolveAndAdmitIdentity(),
      (e: unknown) => codeOf(e) === "controller_closing",
    );
    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (e: unknown) => codeOf(e) === "controller_closing",
    );
    assert.equal(c.rpcRunning, false, "barred work must not spawn a child");
    assert.equal(s.readTranscript().length, 0, "no wire frame at all: barred admission/create never started a transport");

    const outcome = await c.dispose();
    assert.deepEqual(outcome, { code: null, signal: null }, "dispose of a never-started controller is a clean no-op");
    assert.equal(c.lifecycle, "disposed");
    assert.equal(c.lateVm, null, "no create was ever sent, so no late-VM evidence");
  });

  it("admission and create are denied on CLOSED and DISPOSED controllers (terminal states never reopen; zero wire traffic)", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    // Closed controller: create+confirmed close, then further admission/create
    // are denied with the truthful terminal reason (controller_closed).
    const c = s.makeController(policy({ configurationRoot: configDir }));
    await c.prepareAndCreate(pin());
    await c.close(30);
    assert.equal(c.lifecycle, "closed");
    assert.equal(c.isClosed, true);
    await assert.rejects(
      () => c.resolveAndAdmitIdentity(),
      (e: unknown) => codeOf(e) === "controller_closed",
    );
    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (e: unknown) => codeOf(e) === "controller_closed",
    );

    await c.dispose();
    assert.equal(c.lifecycle, "disposed");
    await assert.rejects(
      () => c.resolveAndAdmitIdentity(),
      (e: unknown) => codeOf(e) === "controller_disposed",
    );
    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (e: unknown) => codeOf(e) === "controller_disposed",
    );
    // The VM close was already CONFIRMED before dispose, so a further close is
    // an idempotent no-op (no new close frame, no error) — established
    // semantics preserved from the closed+disposed lifecycle order.
    const framesDisposed = s.readTranscript().length;
    await c.close(30);
    assert.equal(s.readTranscript().length, framesDisposed, "close after a confirmed close+dispose is a no-op; denied admissions/creates never reach the wire");

    // Fresh controller disposed before anything: same terminal denial, zero wire.
    const c2 = s.makeController(policy({ configurationRoot: configDir }));
    await c2.dispose();
    assert.equal(c2.lifecycle, "disposed");
    await assert.rejects(
      () => c2.resolveAndAdmitIdentity(),
      (e: unknown) => codeOf(e) === "controller_disposed",
    );
    await assert.rejects(
      () => c2.prepareAndCreate(pin()),
      (e: unknown) => codeOf(e) === "controller_disposed",
    );
    await assert.rejects(() => c2.close(30), (e: unknown) => codeOf(e) === "controller_disposed");
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "create").length, 1, "only the first controller's real create ever reached the wire");
  });

  it("close during a DELAYED create-path resolve permanently bars the create that would follow the resolve (post-resolve lifecycle recheck)", async (t) => {
    const s = testScaffold(t);
    // resolve_image is held ~700ms. close() is requested while the create
    // path is awaiting that resolve; the post-resolve recheck must refuse to
    // issue create. The create phase disposes its OWNED child; close cannot
    // confirm a VM that never existed -> cleanup_failed (nothing to close).
    s.setFake({ ...HAPPY_FAKE, FAKE_RESOLVE_DELAY_MS: "700" });
    const c = s.makeController(policy({ configurationRoot: configDir }), { requestTimeoutMs: 5_000 });
    const creating = settle(c.prepareAndCreate(pin()));
    await pollUntil(() => transcriptMethodIndexes(s.readTranscript(), "resolve_image").length === 1);
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "resolve_image").length, 1, "resolve must be on the wire before close races it");
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "create").length, 0, "no create yet (resolve still pending)");

    const closing = settle(c.close(30));
    assert.equal(c.lifecycle, "closing", "revocation is synchronous with the valid close request");

    const o = await creating;
    assert.equal(o.ok, false, "prepareAndCreate must not resolve once close began");
    if (!o.ok) assert.equal(codeOf(o.error), "controller_closing", "the post-resolve recheck bars the create");
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "create").length, 0, "NO create frame may ever follow the delayed resolve");

    const cl = await closing;
    assert.equal(cl.ok, false, "close cannot confirm a VM that never existed");
    if (!cl.ok) assert.equal(codeOf(cl.error), "matchlock_cleanup_failed", "no transport remains to confirm a close against");
    assert.equal(c.lifecycle, "closing", "a failed close leaves the permanent closing barrier (retryable, never reopened)");
    assert.equal(c.isClosed, false);
    assert.equal(c.rpcRunning, false, "the create phase disposed its OWNED child on the barrier abort");
    assert.equal(c.lateVm, null, "no create was ever sent, so no late-VM evidence");

    // Wire journal: only the single resolve_image ever reached the wire.
    assert.deepEqual(transcriptMethods(s.readTranscript()), ["resolve_image"], "resolve only — no create, no close frame (no transport to close)");
    const outcome = await c.dispose();
    assert.equal(c.lifecycle, "disposed");
    assert.ok(outcome.code === 0 || (outcome.code === null && outcome.signal === "SIGTERM"), "owned child exit observed");
  });

  it("close racing a DELAYED ADMISSION resolve: the admission still returns its pin (harmless — admission NEVER creates) and prepareAndCreate is permanently entry-barred afterwards", async (t) => {
    const s = testScaffold(t);
    // Hold the admission's resolve so close() provably races an in-flight
    // ADMISSION (the create-path sibling is covered above; this pins the
    // admission path's intent: the pin may return post-close, but no create
    // can ever follow because prepareAndCreate is entry-barred).
    s.setFake({ ...HAPPY_FAKE, FAKE_RESOLVE_DELAY_MS: "500" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    const admitting = settle(c.resolveAndAdmitIdentity());
    await pollUntil(() => transcriptMethodIndexes(s.readTranscript(), "resolve_image").length === 1);
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "resolve_image").length, 1, "the admission resolve must be on the wire before close races it");
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "create").length, 0, "an admission NEVER creates");

    const closing = settle(c.close(30));
    assert.equal(c.lifecycle, "closing", "revocation is synchronous with the valid close request");

    // Admission is entry-gated only (it never issues create, so it has no
    // post-resolve recheck): the delayed resolve still completes and the
    // caller receives the pin — harmless, since the controller is closing and
    // prepareAndCreate is now permanently entry-barred.
    const o = await admitting;
    assert.equal(o.ok, true, "the admission completes with its identity even though close raced the resolve");
    if (o.ok) assert.deepEqual(o.value, pin(), "the resolved pin is returned (admission never creates)");

    // close() waited for the admission phase (single-owner), then found no
    // live transport (the admission disposed its OWNED child) -> cleanup_failed.
    const cl = await closing;
    assert.equal(cl.ok, false, "close cannot confirm a VM that never existed");
    if (!cl.ok) assert.equal(codeOf(cl.error), "matchlock_cleanup_failed", "the admission disposed the only transport; nothing is live to close");
    assert.equal(c.lifecycle, "closing", "a failed close keeps the permanent closing barrier (never reopened)");
    assert.equal(c.isClosed, false, "no close was ever confirmed");
    assert.equal(c.rpcRunning, false, "the admission disposed its owned transport");

    // The returned pin is inert: prepareAndCreate is ENTRY-barred by closing,
    // so no create frame (and no second child) can follow the close-racing
    // admission.
    await assert.rejects(() => c.prepareAndCreate(pin()), (e: unknown) => codeOf(e) === "controller_closing");
    assert.equal(c.lateVm, null, "no create was ever sent, so no late-VM evidence");
    assert.deepEqual(transcriptMethods(s.readTranscript()), ["resolve_image"], "wire: resolve only — no create, no close frame (no live transport to close)");

    const outcome = await c.dispose();
    assert.equal(c.lifecycle, "disposed");
    assert.ok(outcome.code === 0 || (outcome.code === null && outcome.signal === "SIGTERM"), "owned child exit observed");
  });

  it("overlapping resolveAndAdmitIdentity calls are single-flight: ONE owned transport, ONE resolve frame, both callers receive the same identity", async (t) => {
    const s = testScaffold(t);
    // Hold the resolve so the second admission provably overlaps the first.
    s.setFake({ ...HAPPY_FAKE, FAKE_RESOLVE_DELAY_MS: "400" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    const a = settle(c.resolveAndAdmitIdentity());
    const b = settle(c.resolveAndAdmitIdentity());
    const ra = await a;
    const rb = await b;
    assert.equal(ra.ok, true, "first admission resolves");
    assert.equal(rb.ok, true, "overlapping admission joins the single-flight result");
    if (ra.ok) assert.deepEqual(ra.value, pin());
    if (rb.ok) assert.deepEqual(rb.value, pin());
    // Single-flight: exactly ONE owned transport was used — a second child
    // would have journaled a second resolve_image frame.
    assert.deepEqual(transcriptMethods(s.readTranscript()), ["resolve_image"], "overlapping admissions share one resolve over one transport");
    assert.equal(c.rpcRunning, false, "the shared admission transport is disposed before returning");
    assert.equal(c.lifecycle, "open", "a completed admission leaves the controller open");
    assert.equal(c.pinnedImageIdentity, null, "admission never pins; the caller persists the returned identity");

    // The single-shot invocation is NOT consumed by the joined admission: a
    // create with the persisted pin still works on its own fresh transport.
    const created = await c.prepareAndCreate(pin());
    assert.match(created.vmId, /^vm-/);
    assert.deepEqual(transcriptMethods(s.readTranscript()), ["resolve_image", "resolve_image", "create"]);
  });

  it("prepareAndCreate while an admission owns the transport is a clear controller_admission_in_progress error (never a second child); after the admission settles the SAME instance creates", async (t) => {
    const s = testScaffold(t);
    s.setFake({ ...HAPPY_FAKE, FAKE_RESOLVE_DELAY_MS: "400" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    const adm = settle(c.resolveAndAdmitIdentity());
    // The admission owns the transport right now; a create that has not yet
    // persisted the admission identity must fail clearly instead of sharing
    // or disposing the admission's transport.
    await assert.rejects(
      () => c.prepareAndCreate(pin()),
      (e: unknown) => codeOf(e) === "controller_admission_in_progress",
    );
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "create").length, 0, "no create while the admission owns the transport");

    const o = await adm;
    assert.equal(o.ok, true, "the admission still resolves normally");
    if (o.ok) assert.deepEqual(o.value, pin());

    // The rejection did NOT consume the single-shot invocation: once the
    // admission settles, the SAME instance creates normally.
    const created = await c.prepareAndCreate(pin());
    assert.match(created.vmId, /^vm-/);
    assert.deepEqual(transcriptMethods(s.readTranscript()), ["resolve_image", "resolve_image", "create"], "admission resolve, then create-path resolve + create");
  });

  it("a create resolving AFTER close was requested is an owned cleanup obligation: never returned usable/open, cleanup confirmed by the pending close, evidence preserved", async (t) => {
    const s = testScaffold(t);
    // create is ACCEPTED immediately (vm_created) but its response is held
    // 700ms; close() is requested while the create is in flight.
    s.setFake({ ...HAPPY_FAKE, FAKE_CREATE_DELAY_MS: "700" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    const creating = settle(c.prepareAndCreate(pin()));
    await pollUntil(() => transcriptMethodIndexes(s.readTranscript(), "create").length === 1);
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "create").length, 1, "the create request must be on the wire (accepted) before close races it");

    const closing = settle(c.close(30));
    assert.equal(c.lifecycle, "closing", "close revokes work while the create is in flight");

    // Late VM: prepareAndCreate must NOT return a usable/open result.
    const o = await creating;
    assert.equal(o.ok, false, "a create resolving after close must not resolve as usable work");
    if (!o.ok) assert.equal(codeOf(o.error), "late_vm_cleanup_required", "the late VM is an owned cleanup obligation");
    assert.equal(c.isClosed, false, "isClosed is not fabricated by the create response");

    // The pending close then CONFIRMS cleanup over the SAME owned transport.
    const cl = await closing;
    assert.equal(cl.ok, true, "the close that raced the create must settle");
    assert.equal(c.isClosed, true, "cleanup confirmed on the wire after the late VM existed");
    assert.equal(c.lifecycle, "closed");

    // Evidence preserved for controller recovery.
    assert.ok(c.lateVm !== null, "lateVm evidence must be preserved");
    assert.equal(c.lateVm?.vmId, c.identity.vmId, "recovery can target the exact late VM id");
    assert.deepEqual(c.lateVm?.identity, pin());
    assert.equal(c.lateVm?.cleanupConfirmed, true, "cleanup confirmed by the close response (not by transport death)");

    // Wire journal: resolve_image, create (accepted), then the close that
    // confirms cleanup; vm_created precedes vm_closed.
    const txn = s.readTranscript();
    assert.deepEqual(transcriptMethods(txn), ["resolve_image", "create", "close"], "create was in flight before close; the late create settles before close confirms");
    assert.ok(
      txn.findIndex((e) => e.event === "vm_created") >= 0 && txn.findIndex((e) => e.event === "vm_closed") >= 0,
      "both vm_created and vm_closed events must be journaled",
    );
    assert.ok(
      txn.findIndex((e) => e.event === "vm_created") < txn.findIndex((e) => e.event === "vm_closed"),
      "vm_created precedes vm_closed",
    );
    assert.equal(c.rpcRunning, false, "the transport exits cleanly after the confirmed close");

    // The closed barrier still holds for guest work.
    await assert.rejects(() => c.execStream({ command: "x" }, () => {}), (e: unknown) => codeOf(e) === "controller_closed");
    const result = await c.dispose();
    assert.equal(result.code, 0);
  });

  it("dispose while a create request is in flight preserves unconfirmed-create evidence: transport death alone never proves the VM is gone", async (t) => {
    const s = testScaffold(t);
    s.setFake({ ...HAPPY_FAKE, FAKE_CREATE_HANG: "1" });
    const c = s.makeController(policy({ configurationRoot: configDir }), { createTimeoutMs: 20_000 });
    const creating = settle(c.prepareAndCreate(pin()));
    await pollUntil(() => transcriptMethodIndexes(s.readTranscript(), "create").length === 1);
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "create").length, 1, "create request must be in flight before dispose");

    const outcome = await c.dispose();
    assert.equal(c.lifecycle, "disposed", "dispose is terminal");
    assert.equal(c.isClosed, false, "killing the transport is NOT a confirmed VM close");

    const o = await creating;
    assert.equal(o.ok, false, "the in-flight create must reject, not hang");
    if (!o.ok) assert.equal(rpcCodeOf(o.error), MATCHLOCK_CLIENT_ERROR_CODES.DISPOSED, "create rejects with the client DISPOSED error");

    // Evidence: a create was sent but its settlement was destroyed — the
    // runtime may have accepted it. Killing the RPC child alone does not prove
    // the VM is gone, so the evidence is preserved for controller recovery.
    assert.ok(c.lateVm !== null, "in-flight-create evidence must be preserved");
    assert.equal(c.lateVm?.vmId, null, "no create response arrived");
    assert.deepEqual(c.lateVm?.identity, pin(), "the identity that was sent is preserved");
    assert.equal(c.lateVm?.cleanupConfirmed, false, "cleanup was never confirmed");
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "create").length, 1, "exactly one create was ever sent");
    assert.ok(outcome.code === 0 || (outcome.code === null && outcome.signal === "SIGTERM"), "real owned-child exit observed");
    assert.deepEqual(c.rpcExit, outcome, "rpcExit forensics match the observed owned-child exit");
  });

  it("dispose racing the cleanup-confirming close of a REAL late create: final disposed state preserves real-vmId UNCONFIRMED evidence (vmId-set-under-disposed cell), never a fabricated isClosed", async (t) => {
    const s = testScaffold(t);
    // The create is ACCEPTED immediately (vm_created) but its response is held
    // 700ms; close() is requested while the create is in flight, so the create
    // resolves under closing -> a REAL late VM (late_vm_cleanup_required, vmId
    // set). The pending close then drives cleanup over the SAME owned
    // transport, but its own response is held 1500ms — dispose lands while the
    // cleanup confirmation is still in flight, so the terminal state is
    // DISPOSED with the real vmId evidence preserved and cleanup UNCONFIRMED.
    s.setFake({ ...HAPPY_FAKE, FAKE_CREATE_DELAY_MS: "700", FAKE_CLOSE_DELAY_MS: "1500" });
    const c = s.makeController(policy({ configurationRoot: configDir }));
    const creating = settle(c.prepareAndCreate(pin()));
    await pollUntil(() => transcriptMethodIndexes(s.readTranscript(), "create").length === 1);
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "create").length, 1, "the create request must be on the wire (accepted) before close races it");

    const closing = settle(c.close(30));
    assert.equal(c.lifecycle, "closing", "close revokes work while the create is in flight");

    // The create response resolves under closing: real late VM, never usable.
    const o = await creating;
    assert.equal(o.ok, false, "a create resolving after close must not resolve as usable work");
    if (!o.ok) assert.equal(codeOf(o.error), "late_vm_cleanup_required", "the late VM is an owned cleanup obligation");
    assert.equal(c.isClosed, false, "isClosed is not fabricated by the create response");
    assert.ok(c.lateVm !== null && c.lateVm.vmId !== null, "the real late VM id must be recorded before dispose");
    assert.equal(c.lateVm?.vmId, c.identity.vmId, "the recorded late-VM id is the exact created id");
    assert.equal(c.lateVm?.cleanupConfirmed, false, "cleanup is not yet confirmed");

    // The pending close now confirms cleanup on the SAME transport. Wait until
    // its close request is on the wire, then dispose BEFORE the (1500ms-held)
    // close response arrives: dispose must win over the unconfirmed close.
    await pollUntil(() => transcriptMethodIndexes(s.readTranscript(), "close").length === 1);
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "close").length, 1, "the cleanup-confirming close must be on the wire before dispose races it");

    const outcome = await c.dispose();
    assert.equal(c.lifecycle, "disposed", "dispose is terminal and is never overwritten by the interrupted close");
    assert.equal(c.isClosed, false, "the close was never CONFIRMED (dispose interrupted it) — no fabricated isClosed");

    // The interrupted cleanup-confirming close rejects cleanly (bounded).
    const cl = await closing;
    assert.equal(cl.ok, false, "an in-flight close interrupted by dispose must reject, not hang");
    if (!cl.ok) assert.equal(isRpcError(cl.error, MATCHLOCK_CLIENT_ERROR_CODES.DISPOSED), true, "the interrupted close rejects with the client DISPOSED error");

    // Evidence cell: REAL vmId set, cleanup UNCONFIRMED, terminal disposed —
    // the missing disposed counterpart of the closing/cleanup-confirmed case.
    assert.ok(c.lateVm !== null, "real-vmId evidence must be preserved under disposed");
    assert.equal(c.lateVm?.vmId, c.identity.vmId, "recovery can still target the exact late VM id");
    assert.deepEqual(c.lateVm?.identity, pin(), "the identity that was sent is preserved");
    assert.equal(c.lateVm?.cleanupConfirmed, false, "cleanup stayed UNCONFIRMED (dispose cannot confirm a VM close)");
    assert.equal(transcriptMethodIndexes(s.readTranscript(), "create").length, 1, "exactly one create was ever sent");

    // Wire journal: resolve_image -> create (accepted) -> close (interrupted);
    // vm_created precedes the close frame; NO vm_closed (never confirmed).
    const txn = s.readTranscript();
    const createdIdx = txn.findIndex((e) => e.event === "vm_created");
    const closedIdx = txn.findIndex((e) => e.event === "vm_closed");
    assert.ok(createdIdx >= 0, "vm_created must be journaled (the VM really began booting)");
    assert.equal(closedIdx, -1, "vm_closed must NOT be journaled (dispose interrupted the confirming close)");
    assert.deepEqual(transcriptMethods(txn), ["resolve_image", "create", "close"], "resolve + create, then the interrupted cleanup close");

    assert.ok(outcome.code === 0 || (outcome.code === null && outcome.signal === "SIGTERM"), "real owned-child exit observed");
    assert.deepEqual(c.rpcExit, outcome, "rpcExit forensics match the observed owned-child exit");

    // Terminal disposed barrier still holds for guest work and new invocations.
    await assert.rejects(() => c.execStream({ command: "x" }, () => {}), (e: unknown) => codeOf(e) === "controller_disposed");
    await assert.rejects(() => c.prepareAndCreate(pin()), (e: unknown) => codeOf(e) === "controller_disposed");
    const again = await c.dispose();
    assert.deepEqual(again, outcome, "dispose stays idempotent");
  });

  // ── US-004: pre-flight SUN_LEN refusal before any RPC/VM effect ────

  /** A sentinel "rpc binary" that records execution; if the pre-flight ever
   *  failed to fire, the marker file would exist (a real child was spawned). */
  function spawnSentinel(t: { after: (fn: () => Promise<unknown> | void) => void }, name: string): {
    binary: string;
    marker: string;
    wasSpawned: () => boolean;
  } {
    const marker = path.join(tmp, `us004-${name}-spawn-marker`);
    fs.rmSync(marker, { force: true });
    const binary = path.join(tmp, `us004-${name}-sentinel.sh`);
    fs.writeFileSync(binary, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
    t.after(() => fs.rmSync(marker, { force: true }));
    return { binary, marker, wasSpawned: () => fs.existsSync(marker) };
  }

  it("refuses a HOME whose longest matchlock socket path exceeds 107 bytes BEFORE any rpc child is spawned", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const sentinel = spawnSentinel(t, "admission");
    // 90-char HOME (the real-model qualification failure) => 90 + 43 = 133.
    const longHome = "/" + "h".repeat(89);
    assert.equal(longHome.length, 90);

    const c = new MatchlockController(policy({ configurationRoot: configDir }), {
      rpcBinaryPath: sentinel.binary,
      rpcArgs: [],
      helperPackHostPath: helperPack,
      rpcEnv: { HOME: longHome },
    });
    t.after(() => c.dispose());

    const admitted = await settle(c.resolveAndAdmitIdentity());
    assert.equal(admitted.ok, false, "a long-HOME admission must be refused");
    if (!admitted.ok) {
      assert.equal(codeOf(admitted.error), "matchlock_home_socket_path_too_long");
      const message = admitted.error instanceof Error ? admitted.error.message : String(admitted.error);
      assert.match(message, /107/, "message names the 107-byte limit");
      assert.ok(message.includes("133"), "message names the computed length");
      assert.ok(message.includes(longHome), "message names the HOME in use");
      assert.ok(message.includes("TAMANDUA_MATCHLOCK_HOME_ALIAS"), "message names the remedy");
    }
    assert.equal(sentinel.wasSpawned(), false, "the pre-flight must fire BEFORE any rpc child spawn");
    assert.equal(c.rpcRunning, false, "no owned transport exists");
    assert.deepEqual(s.readTranscript(), [], "no RPC request may ever reach the wire");
  });

  it("refuses the same long HOME at prepareAndCreate entry with no create child", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const sentinel = spawnSentinel(t, "create");
    const longHome = "/" + "h".repeat(89);

    const c = new MatchlockController(policy({ configurationRoot: configDir }), {
      rpcBinaryPath: sentinel.binary,
      rpcArgs: [],
      helperPackHostPath: helperPack,
      rpcEnv: { HOME: longHome },
    });
    t.after(() => c.dispose());

    const created = await settle(c.prepareAndCreate(pin()));
    assert.equal(created.ok, false, "a long-HOME create must be refused");
    if (!created.ok) assert.equal(codeOf(created.error), "matchlock_home_socket_path_too_long");
    assert.equal(sentinel.wasSpawned(), false, "create must refuse before any rpc child spawn");
    assert.equal(c.rpcRunning, false, "no owned transport exists");
    assert.equal(c.identity.vmId, null, "no VM id may ever be recorded");
    assert.deepEqual(s.readTranscript(), [], "no RPC request may ever reach the wire");
  });

  it("passes the pre-flight for a short alias HOME and admission proceeds normally", async (t) => {
    const s = testScaffold(t);
    s.setFake(HAPPY_FAKE);
    const shortHome = "/tmp/tamandua/1234/h";
    const c = s.makeController(policy({ configurationRoot: configDir }), {}, { HOME: shortHome });
    const identity = await c.resolveAndAdmitIdentity();
    assert.deepEqual(identity, pin(), "a short alias HOME must not be refused");
    assert.deepEqual(transcriptMethods(s.readTranscript()), ["resolve_image"]);
  });
});
