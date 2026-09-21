/**
 * MTLK-DSH-EXEC US-004 — committed-source documentation regression for the
 * dsh Matchlock opt-in.
 *
 * Pure filesystem reads (no child_process, no daemon, no VM, no network), so
 * this file stays in the parallel lane and needs no tests/serial-files.txt
 * entry. It pins the operator-facing artifacts that US-004 required:
 *   - README Matchlock section: dsh opt-in, whole-home RW mount, capability
 *     matrix, fixture/gate tier, unpinned runtime resolution, test
 *     classification;
 *   - skills/tamandua-agents/SKILL.md: dsh-under-Matchlock subsection;
 *   - docs/matchlock-dsh-qualification.md: production recipe, real-vs-synthetic
 *     coverage boundary and remaining real-dsh work.
 */
// Union4 rewrite (documented in tests/matchlock-integration-test-parity.test.ts
// REWRITTEN_ASSERTIONS): the MTLK-DSH-EXEC US-004 contract asserted the
// "records the accepted paired-runtime pins" / "records the accepted paired
// runtime pins" assertions, which REFUSED when the runtime sha256 hashes did
// not match the pins. The MTLK-UNPIN contract removes every runtime pin, so
// both titles were rewritten to "documents the unpinned runtime resolution and
// observed identity" / "documents the unpinned runtime identity" and now assert
// observed-not-pinned behavior instead. Both contracts named here:
// MTLK-DSH-EXEC vs MTLK-UNPIN.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

const readme = readRepoFile("README.md");
const skill = readRepoFile("skills/tamandua-agents/SKILL.md");

// README slice from the Matchlock heading to the next H5, so assertions about
// the dsh Matchlock entry cannot pass by matching the native dsh alpha section.
const matchlockHeading = "##### Matchlock Execution (`--matchlock`)";
const matchlockStart = readme.indexOf(matchlockHeading);
const matchlockSection =
  matchlockStart >= 0
    ? readme.slice(matchlockStart, readme.indexOf("##### Doctor Contract Check", matchlockStart))
    : "";

describe("README documents the dsh Matchlock opt-in (MTLK-DSH-EXEC US-004)", () => {
  it("has the Matchlock section", () => {
    assert.ok(matchlockStart >= 0, "README must have a Matchlock Execution section");
  });

  it("documents --dsh-as-harness with --matchlock and the whole-home RW mount", () => {
    assert.match(matchlockSection, /--dsh-as-harness/);
    assert.match(matchlockSection, /read-write at the guest `\/workspace\/config\/dsh` as one mount/);
    assert.match(matchlockSection, /sessions\/`, `profiles\/`, `storages\/`, credentials and unknown/);
    assert.match(matchlockSection, /dsh --profile headless <prompt>/);
  });

  it("documents the supported workflows and refused merge/child-orchestration capabilities", () => {
    assert.match(matchlockSection, /Admitted for all three harnesses:/);
    assert.match(matchlockSection, /no harness-by-workflow allow-list/);
    assert.match(matchlockSection, /`\*-github-pr` needs a guest `gh` CLI/);
    assert.match(matchlockSection, /refused before any VM\/probe\/native harness\s+starts/);
    assert.match(matchlockSection, /\*not\* completed overall\s+workflow support/);
  });

  it("documents the on-demand dsh gate tier and that it is not in default lanes", () => {
    assert.match(matchlockSection, /e2e-tests\/matchlock-dsh-gate\.test\.ts/);
    assert.match(matchlockSection, /\.\/run-matchlock-dsh-gate-e2e-test/);
    assert.match(matchlockSection, /never\*\* part of\s+`\.\/run-all-e2e-tests`, `npm test`/);
    assert.match(matchlockSection, /test-only derived synthetic fixture image/);
    assert.match(matchlockSection, /igorhvr\/bedlam-ubuntu` image\/tag is never overwritten/);
  });

  it("documents the unpinned runtime resolution and observed identity", () => {
    assert.doesNotMatch(matchlockSection, /a278f9c1|f76f00fb/);
    assert.doesNotMatch(matchlockSection, /accepted matchlock CLI sha256|accepted guest-init sha256/);
    assert.match(matchlockSection, /unpinned/i);
    assert.match(matchlockSection, /TAMANDUA_MATCHLOCK_RPC_BIN/);
    assert.match(matchlockSection, /MATCHLOCK_GUEST_INIT/);
    assert.match(matchlockSection, /MATCHLOCK_GUEST_FUSED/);
    assert.match(matchlockSection, /runtime-observed\.txt/);
  });

  it("documents the dsh test classification and references the production recipe", () => {
    assert.match(matchlockSection, /dsh-\*\.ts` module\s+graph is process-spawn-free/);
    assert.match(matchlockSection, /dsh-scheduler-seam\.test\.ts`.*serial-files\.txt/s);
    assert.match(matchlockSection, /docs\/matchlock-dsh-qualification\.md/);
  });
});

describe("SKILL.md documents dsh under Matchlock (MTLK-DSH-EXEC US-004)", () => {
  const heading = "#### dsh under Matchlock (opt-in, MTLK-DSH-EXEC)";
  const start = skill.indexOf(heading);
  const section =
    start >= 0 ? skill.slice(start, skill.indexOf("## Services & maintenance", start)) : "";

  it("has the dsh-under-Matchlock subsection", () => {
    assert.ok(start >= 0, `SKILL.md must contain '${heading}'`);
  });

  it("documents fresh-VM per round, submission-time DSH_HOME and whole RW mount", () => {
    assert.match(section, /\*\*fresh Matchlock VM\*\*/);
    assert.match(section, /resolved once at \*\*submission\*\* time/);
    assert.match(section, /whole and read-write at the guest\s+`\/workspace\/config\/dsh` as one mount/);
    assert.match(section, /sessions\/`, `profiles\/`,\s+`storages\/`/);
  });

  it("documents supported workflows, refusals and honest usage accounting", () => {
    assert.match(section, /same full capability-closed set as\s+`pi`/);
    assert.match(section, /There is no\s+harness-by-workflow allow-list/);
    assert.match(section, /refused before any VM\/probe\/native harness\s+starts/);
    assert.match(section, /never fabricated as a zero/);
  });

  it("documents the test classification for the dsh slice", () => {
    assert.match(section, /process-spawn-free/);
    assert.match(section, /dsh-scheduler-seam\.test\.ts` is in\s+`tests\/serial-files\.txt`/);
    assert.match(section, /run-matchlock-dsh-gate-e2e-test/);
  });
});

describe("docs/matchlock-dsh-qualification.md production recipe (US-004)", () => {
  const recipePath = "docs/matchlock-dsh-qualification.md";

  it("exists", () => {
    assert.ok(existsSync(resolve(repoRoot, recipePath)), `${recipePath} must exist`);
  });

  const recipe = existsSync(resolve(repoRoot, recipePath)) ? readRepoFile(recipePath) : "";

  it("documents the unpinned runtime identity", () => {
    assert.doesNotMatch(recipe, /a278f9c1|f76f00fb/);
    assert.match(recipe, /unpinned/i);
    assert.match(recipe, /TAMANDUA_MATCHLOCK_RPC_BIN/);
    assert.match(recipe, /MATCHLOCK_GUEST_INIT/);
    assert.match(recipe, /MATCHLOCK_GUEST_FUSED/);
    assert.match(recipe, /runtime-observed\.txt/);
  });

  it("states the real opt-in recipe and the supported workflows", () => {
    assert.match(recipe, /tamandua workflow run do-now/);
    assert.match(recipe, /--dsh-as-harness --matchlock <image>/);
    assert.match(recipe, /`do-now`, `do-review-do-verify`/);
  });

  it("states the real-vs-synthetic coverage boundary", () => {
    assert.match(recipe, /Real-vs-synthetic coverage boundary/);
    assert.match(recipe, /NOT covered \(real dsh work that remains\)/);
    assert.match(recipe, /No real model, credential, provider or network call/);
  });

  it("lists the remaining real dsh / full-workflow / platform work", () => {
    assert.match(recipe, /real `dsh` model-backed rounds with real provider credentials/);
    assert.match(recipe, /full generic workflow support/i);
    assert.match(recipe, /DSV2/);
    assert.match(recipe, /platform\/root acceptance/);
  });

  it("documents the focused regression and retained-evidence conventions", () => {
    assert.match(recipe, /Focused committed-source regression/);
    assert.match(recipe, /serial-classification-guard\.test\.ts/);
    assert.match(recipe, /Retained evidence conventions/);
    assert.match(recipe, /never treat(?:ed)? as empty|never\s+treated as empty/);
  });
});

describe("docs/matchlock-dsh-qualification.md composed dsh home mapping (DSH-PROFILE-OVERLAY / DSH-OVERLAY-FSYNC-FIX)", () => {
  const recipePath = "docs/matchlock-dsh-qualification.md";
  const recipe = existsSync(resolve(repoRoot, recipePath)) ? readRepoFile(recipePath) : "";

  it("documents the single effective-home root destination and the private profiles/ copy", () => {
    assert.match(recipe, /Composed DSH_HOME mapping \(DSH-PROFILE-OVERLAY \/ DSH-OVERLAY-FSYNC-FIX\)/);
    assert.match(recipe, /\*\*ONE\*\* `host_fs`\s+read-write destination at the guest configuration root/);
    assert.match(recipe, /the \*\*whole\*\* `profiles\/` directory/);
    assert.match(recipe, /private\*\* per-run staged overlay copy `<overlayRoot>\/profiles`/);
    assert.match(recipe, /per-run staged overlay copy/);
  });

  it("lists every real top-level durable entry with host source, guest destination and fsync status", () => {
    assert.match(recipe, /### Final layout/);
    assert.match(recipe, /Host source \(per-run effective home\)/);
    assert.match(recipe, /Guest destination/);
    assert.match(recipe, /Writable \/ `fsync`-able/);
    assert.match(recipe, /hard link `<overlayRoot>\/\.credentials\.yaml`/);
    assert.match(recipe, /hard link\/copy `<overlayRoot>\/\.anonymous-user-id`/);
    assert.match(recipe, /EMPTY real directory `<overlayRoot>\/sessions`/);
    assert.match(recipe, /EMPTY real directory `<overlayRoot>\/storages`/);
    assert.match(recipe, /any other durable top-level entry/);
    assert.match(recipe, /the single mount source is a real host directory/);
  });

  it("documents the private per-run effective home root", () => {
    assert.match(recipe, /private per-run copy/);
    assert.match(recipe, /dsh-profile-overlays\/<bareRunId>/);
    assert.match(recipe, /prepareDshProfileOverlay/);
    assert.match(recipe, /cleanupDshProfileOverlay/);
    assert.match(recipe, /publishDshHomeOverlayToHost/);
  });

  it("documents that DSH_HOME is unchanged", () => {
    assert.match(recipe, /`DSH_HOME` is \*\*unchanged\*\* in the guest/);
    assert.match(recipe, /stays `\/workspace\/config\/dsh`/);
  });

  it("names the failing syscall/path from the run-#35 diagnosis", () => {
    assert.match(recipe, /Why the previous mapping could not fsync/);
    assert.match(recipe, /fsync\(<DSH_HOME>\)` returned `ENOENT`/);
    assert.match(recipe, /exactFUSEMountpoints/);
    assert.match(recipe, /`\/workspace\/config\/dsh` \(the `\$DSH_HOME` ROOT itself\)/);
    assert.match(recipe, /guest-node-fs-shim/);
    assert.match(recipe, /PTRACE_TRACEME: Operation not permitted/);
    assert.match(recipe, /planReconciliation\.matches=false/);
    assert.match(recipe, /dsh-fsync-diagnosis\.json/);
  });

  it("explains the fix and why it is ONE root mount", () => {
    assert.match(recipe, /The fix \(why the shipped mapping is ONE root mount\)/);
    assert.match(recipe, /nested destinations are runtime-rejected/);
    assert.match(recipe, /ONE real host-backed root mount/);
    assert.match(recipe, /`planDshHomeMounts` emits exactly ONE/);
    assert.match(recipe, /guestConfigurationRoot -> overlayRoot/);
  });

  it("records why #34's gates missed the home-root fsync", () => {
    assert.match(recipe, /Why #34's gates missed the home-root `fsync`/);
    assert.match(recipe, /stageGateOwnedDshHome/);
    assert.match(recipe, /providers: \{\}/);
    assert.match(recipe, /credentials-local/);
  });

  it("preserves the #34 profiles/ boot-lock enumeration and root cause", () => {
    assert.match(recipe, /Every path dsh touches under `profiles\/`/);
    assert.match(recipe, /profiles\/node_modules\.lock/);
    assert.match(recipe, /withFileLock\(modulesDir\)/);
    assert.match(recipe, /profiles\/<profile>\/package\.json/);
    assert.match(recipe, /profiles\/<profile>\/cordis\.patch\.yml/);
    assert.match(recipe, /profiles\/<profile>\/pnpm-workspace\.yaml/);
    assert.match(recipe, /profiles\/<profile>\/\.dsh-module-fallback/);
    assert.match(recipe, /PROFILE_MODULE_FALLBACK_DIR/);
    assert.match(recipe, /Why the private `profiles\/` copy covers every path/);
    assert.match(recipe, /destination for `profiles\/` itself/);
  });

  it("preserves the #34 cross-world healProfilesModuleFallback root cause", () => {
    assert.match(recipe, /healProfilesModuleFallback/);
    assert.match(recipe, /REQUEST_EXTENSION/);
    assert.match(recipe, /each guest boot flipped the farm to guest paths/);
  });

  it("states the isolation guarantee for both directions", () => {
    assert.match(recipe, /Isolation guarantee/);
    assert.match(recipe, /guest can \*\*never\*\* flip the host farm/);
    assert.match(recipe, /native\*\* dsh boot cannot break a concurrent in-VM round/);
    assert.match(recipe, /byte-identical before and after an in-VM round/);
  });

  it("states host durable categories are host-backed and the host farm/lock stay untouched", () => {
    assert.match(recipe, /Host \*\*durable\*\* categories are host-backed/);
    assert.match(recipe, /Only the\s+`profiles\/` tree is private/);
    assert.match(recipe, /host farm \*\*and the host lock\*\* are byte-identical/);
  });

  it("records the two TUNSETIFF gate-run evidence paths", () => {
    assert.match(recipe, /dsh-profile-overlay-20260916T193304Z\/gate-run\.log/);
    assert.match(recipe, /dsh-profile-overlay-20260916T221513Z\/gate-run\.log/);
    assert.match(recipe, /TUNSETIFF: operation not permitted/);
  });

  it("records the synthetic-probe and real-gate why-missed gaps", () => {
    assert.match(recipe, /Why #31's gates missed the boot-lock failure/);
    assert.match(recipe, /runFirstRequestProbe/);
    assert.match(recipe, /SIBLING/);
    assert.match(recipe, /real-dsh gate was not part of #31's required gate set/);
    assert.match(recipe, /matchlock-dsh-real-boot-gate\.test\.ts/);
  });

  it("records the known profiles/** non-persistence limitation", () => {
    assert.match(recipe, /Known limitation/);
    assert.match(recipe, /inside `profiles\/` are \*\*not\*\*\s+host-persisted/);
  });

  it("no longer claims the raw host home is mounted per-entry or as one whole unit", () => {
    assert.doesNotMatch(recipe, /whole frozen effective home, RW, one mount/i);
    assert.doesNotMatch(recipe, /The whole directory is mounted RW at `\/workspace\/config\/dsh`/);
    assert.doesNotMatch(recipe, /mounted read-write from the host home at their normal\s+guest paths/);
    assert.doesNotMatch(recipe, /guestConfigurationRoot\/<entry>`/);
  });
});
