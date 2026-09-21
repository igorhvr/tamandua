/**
 * native-step-progress.test.ts — MTLK-PROGRESS.
 *
 * ACTUAL NativeStepServices + real isolated run/step DB + a host progress
 * RESOURCE accessor:
 *
 *   1. When a NativeStepServices is constructed with an opt-in progress
 *      resource, ACTUAL claimed/current input contains the guest-visible
 *      progress path (`/workspace/runs/<runId>/progress.txt`), while the SAME
 *      step claimed without the resource renders the native canonical host
 *      path — a no-flag differential that must stay byte-for-byte.
 *   2. Host story-plan writes (step-ops writeStoryPlanToProgress with the
 *      resource access) and host readProgressFile see EXACTLY the committed
 *      resource content across two sequential fresh attachments (host
 *      filesystem simulation; NO actualVM — actualVM is not authorized here).
 *   3. Negative control: with a resource attached, host reads never fall back
 *      to legacy/workspace files after an opted-in refusal.
 *   4. completeStep forwards the opt-in progress access into the
 *      post-completion host story-plan write (same document the guest sees).
 *
 * Serial lane (real DB + step-ops machinery).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import {
  archiveRunProgress,
  getRunProgressPath,
  readProgressFile,
  writeStoryPlanToProgress,
} from "../../../dist/installer/step-ops.js";
import { NativeStepServices } from "../../../dist/installer/matchlock/native-step-services.js";
import { HostInvocationRegistry } from "../../../dist/installer/matchlock/native-step-invocations.js";
import {
  AGENT,
  JOB_ID,
  RUN,
  applyEnv,
  bindingFor,
  createIsolatedState,
  snapshotEnv,
  type IsolatedState,
} from "../../../dist/installer/matchlock/native-step-test-utils.js";
import {
  PROGRESS_DOC_FILE_NAME,
  ProgressResourceAccess,
  attachRunProgressResource,
  progressGuestFileForRun,
  progressHostFile,
} from "../../../dist/installer/matchlock/progress-resource.js";

const INV = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const STEP1 = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const sticky = createIsolatedState("prog-svc-sticky");
sticky.open();
const stickyEnv = snapshotEnv();

after(() => {
  try {
    sticky.dispose(stickyEnv);
  } catch {
    /* best-effort */
  }
});

afterEach(() => {
  applyEnv(stickyEnv);
});

interface Rig {
  st: IsolatedState;
  registry: HostInvocationRegistry;
  /** Host progress resource host dir (under isolated state runs root). */
  hostDir: string;
  /** Guest-visible progress file for RUN. */
  guestFile: string;
}

function makeRig(): Rig {
  const st = createIsolatedState("prog-svc");
  st.open();
  st.insertRun({ workflowId: "test" });
  // Host attaches the deterministic progress resource dir under the isolated
  // state root (host-attested; guest never supplies the path).
  const resource = attachRunProgressResource(RUN, { runRoot: path.join(st.root, "state", "runs") });
  const registry = new HostInvocationRegistry();
  const r = registry.admitInvocation({ invocationId: INV, runId: RUN, agentId: AGENT, jobId: JOB_ID });
  assert.equal(r.ok, true);
  return { st, registry, hostDir: resource.hostDir, guestFile: resource.guestFile };
}

function svcFor(rig: Rig, progressResource?: ProgressResourceAccess): NativeStepServices {
  return new NativeStepServices({
    binding: bindingFor(INV),
    registry: rig.registry,
    workerOwnership: { jobId: JOB_ID, pid: 424242 },
    ...(progressResource ? { progressResource } : {}),
  });
}

/** HOST-FS SIMULATION of the guest writing through the directory mount. */
function simGuestWrite(hostDir: string, content: string): void {
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, PROGRESS_DOC_FILE_NAME), content, "utf8");
}

function seedStoryStep(st: IsolatedState, stepId: string): void {
  // A LOOP step over stories: claimStep claims the first pending story and
  // injects the progress pointer; stepCurrent (readClaim) renders the current
  // story context with the same pointer — both are story-bearing render paths.
  st.insertStep({
    id: stepId,
    type: "loop",
    status: "pending",
    inputTemplate: "progress file: {{progress_file}}\nprogress prose: {{progress}}",
    loopConfig: JSON.stringify({ over: "stories", verifyEach: false }),
    stepIndex: 0,
  });
  st.insertStory({ id: "story-1", status: "pending", storyId: "US-1", title: "T", description: "D", acceptanceCriteria: ["A"] });
}

describe("MTLK-PROGRESS adapter seam (real DB; host-fs simulation, NOT actualVM)", () => {
  it("claim with an opt-in progress resource renders the guest-visible pointer; the SAME step without the resource keeps the native canonical host path", async () => {
    const rigGuest = makeRig();
    try {
      seedStoryStep(rigGuest.st, STEP1);
      const access = new ProgressResourceAccess(rigGuest.hostDir, { guestFile: rigGuest.guestFile });

      const guest = svcFor(rigGuest, access);
      const claimGuest = await guest.claim(bindingFor(INV));
      assert.equal(claimGuest.found, true);
      assert.ok(claimGuest.input);
      assert.ok(
        claimGuest.input.includes(`progress file: ${rigGuest.guestFile}`),
        `claimed input must contain the guest-visible progress file; got: ${claimGuest.input}`,
      );
      assert.ok(!claimGuest.input.includes(getRunProgressPath(RUN)), "guest input must not leak the host canonical path");

      // readClaim (step current) renders the same guest pointer.
      const currentGuest = await guest.readClaim(bindingFor(INV));
      assert.ok(currentGuest, "guest invocation holds the claim");
      assert.ok(currentGuest.input.includes(rigGuest.guestFile), `current input must contain the guest pointer; got: ${currentGuest.input}`);
    } finally {
      rigGuest.st.dispose(stickyEnv);
    }

    // Native no-flag differential: no resource -> canonical host path.
    const rigNative = makeRig();
    try {
      seedStoryStep(rigNative.st, STEP1);
      const native = svcFor(rigNative, undefined);
      const claimNative = await native.claim(bindingFor(INV));
      assert.equal(claimNative.found, true);
      assert.ok(claimNative.input);
      assert.ok(claimNative.input.includes(getRunProgressPath(RUN)), `native claim must keep the canonical host path; got: ${claimNative.input}`);
    } finally {
      rigNative.st.dispose(stickyEnv);
    }
  });

  it("host story-plan write with the resource access commits into the SAME document and host read observes it across two fresh attachments", () => {
    const rig = makeRig();
    try {
      // Seed stories so writeStoryPlanToProgress has a plan to write.
      rig.st.insertStory({ id: "story-1", status: "pending", storyId: "US-1", title: "T", description: "D", acceptanceCriteria: ["A"] });

      // Attachment 1: host story-plan write goes through the confined accessor.
      const access1 = new ProgressResourceAccess(rig.hostDir, { guestFile: rig.guestFile });
      writeStoryPlanToProgress(RUN, access1);
      const committed1 = readProgressFile(RUN, access1);
      assert.ok(committed1.includes("## Story Plan"), "host story plan must be in the resource doc");
      assert.ok(committed1.includes("US-1"), "story plan content must be committed");

      // Simulated guest append (host-fs) must be observed by the host reader.
      simGuestWrite(rig.hostDir, "# Progress\n" + committed1 + "guest line\n");

      // Attachment 2 (fresh invocation attaches the same host dir): host
      // reader sees exactly the committed content (no blank re-init).
      const access2 = new ProgressResourceAccess(rig.hostDir, { guestFile: rig.guestFile });
      const committed2 = readProgressFile(RUN, access2);
      assert.ok(committed2.includes("## Story Plan"));
      assert.ok(committed2.includes("guest line"), "guest append must survive detach/re-attach");
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("host archiveRunProgress with the resource access archives EXACTLY the committed doc into the run archive dir and clears the resource doc", () => {
    const rig = makeRig();
    try {
      rig.st.insertStory({ id: "story-1", status: "pending", storyId: "US-1", title: "T", description: "D", acceptanceCriteria: ["A"] });
      const access = new ProgressResourceAccess(rig.hostDir, { guestFile: rig.guestFile });
      writeStoryPlanToProgress(RUN, access);
      simGuestWrite(rig.hostDir, "# Progress\n" + (access.readText() ?? "") + "guest line\n");

      archiveRunProgress(RUN, access);
      // The archived copy is exactly the committed content.
      const archivePath = path.join(rig.st.root, "state", "runs", RUN, "archive", PROGRESS_DOC_FILE_NAME);
      assert.equal(fs.existsSync(archivePath), true, "archive file must exist");
      const archived = fs.readFileSync(archivePath, "utf8");
      assert.ok(archived.includes("guest line"), "archive must contain the committed guest content");
      assert.ok(archived.includes("## Story Plan"), "archive must contain the host story plan");
      // Resource doc cleared after archive (mirrors native archiveRunProgress
      // unlink semantics) but the resource DIRECTORY persists.
      assert.equal(access.readText(), null, "resource doc cleared after archive");
      assert.equal(access.exists, true, "resource directory persists after archive");
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("host story-plan write with a guest-planted symlink leaf refuses (no host escape) and does NOT write through the link", () => {
    const rig = makeRig();
    try {
      rig.st.insertStory({ id: "story-1", status: "pending", storyId: "US-1", title: "T", description: "D", acceptanceCriteria: ["A"] });
      const outside = path.join(rig.st.root, "outside.txt");
      fs.writeFileSync(outside, "host secret", "utf8");
      fs.symlinkSync(outside, progressHostFile(rig.hostDir), "file");

      const access = new ProgressResourceAccess(rig.hostDir, { guestFile: rig.guestFile });
      // Native story-plan writes swallow failures with a warning (parity), so
      // the assertion is that the write did NOT follow/change the link target
      // and the refusal surfaces on the confined read path.
      writeStoryPlanToProgress(RUN, access);
      assert.equal(fs.readFileSync(outside, "utf8"), "host secret", "outside target must be untouched");
      assert.equal(fs.lstatSync(progressHostFile(rig.hostDir)).isSymbolicLink(), true, "symlink leaf must remain (never replaced by a follow-through write)");
      assert.throws(
        () => readProgressFile(RUN, access),
        (e: unknown) => e instanceof Error && (e as { code?: string }).code === "progress_special_file",
      );
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("with a resource attached host reads NEVER fall back to legacy/workspace files after an opted-in refusal", () => {
    const rig = makeRig();
    try {
      // Guest plants a symlink leaf inside the resource dir (host escape
      // canary). Host readProgressFile with the access must refuse, and must
      // NOT silently fall back to a legacy file.
      const hostFile = progressHostFile(rig.hostDir);
      const outside = path.join(rig.st.root, "secret.txt");
      fs.writeFileSync(outside, "host secret", "utf8");
      fs.symlinkSync(outside, hostFile, "file");

      const access = new ProgressResourceAccess(rig.hostDir, { guestFile: rig.guestFile });
      assert.throws(
        () => readProgressFile(RUN, access),
        (e: unknown) => e instanceof Error && (e as { code?: string }).code === "progress_special_file",
      );
      assert.equal(fs.readFileSync(outside, "utf8"), "host secret", "outside target must be untouched");
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("host canonical path function and legacy read remain unchanged when no resource is attached", () => {
    const rig = makeRig();
    try {
      const canonical = getRunProgressPath(RUN);
      assert.ok(canonical.endsWith(`runs/${RUN}/progress.txt`));
      // Native readProgressFile (no access) keeps canonical-first + fallback
      // semantics (returns a string, never throws on an absent file).
      const content = readProgressFile(RUN);
      assert.equal(typeof content, "string");
      // progressGuestFileForRun is the advertised guest mapping (opt-in only).
      assert.equal(progressGuestFileForRun(RUN), `/workspace/runs/${RUN}/progress.txt`);
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });

  it("completeStep forwards an opt-in progress access to the post-completion host story-plan write", async () => {
    const rig = makeRig();
    try {
      rig.st.insertStep({
        id: STEP1,
        stepId: "plan",
        status: "pending",
        inputTemplate: "task",
        expects: "STATUS: done",
      });
      // A story row so runHasStories() is true; completeStep's wrapper writes
      // the story plan through options.progressAccess when supplied.
      rig.st.insertStory({ id: "story-1", status: "pending", storyId: "US-1", title: "T", description: "D", acceptanceCriteria: ["A"] });

      const access = new ProgressResourceAccess(rig.hostDir, { guestFile: rig.guestFile });
      const svc = svcFor(rig, access);
      const claim = await svc.claim(bindingFor(INV));
      assert.equal(claim.found, true);
      assert.ok(claim.stepId);
      const held = await svc.readClaim(bindingFor(INV));
      assert.ok(held, "invocation should hold the claimed step");
      assert.ok(held.claimId);

      const outcome = await svc.submitCompletion(bindingFor(INV), held.claimId, claim.stepId, "STATUS: done");
      assert.ok(["advanced", "completed"].includes(outcome.status), `status was ${outcome.status}`);
      // The story plan must be committed into the RESOURCE doc (guest sees it
      // on the next VM), readable via the confined host accessor.
      const text = readProgressFile(RUN, access);
      assert.ok(text.includes("## Story Plan"), `resource doc must contain the story plan after completeStep; got: ${text}`);
    } finally {
      rig.st.dispose(stickyEnv);
    }
  });
});
