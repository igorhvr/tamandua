/**
 * interactive-hermes-selection.test.ts — MTLK-INTERACTIVE (US-007).
 *
 * Parallel lane: the tested module imports only the pure Hermes adapter/profile
 * modules (no `child_process`), so no serial registration is required. The
 * tests use real temporary directories for the default adapter path and inject
 * a minimal adapter plan for the refusals that the shipped adapter cannot
 * currently produce (a REQUIRED external dependency) or for synthetic scope
 * shapes.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  INTERACTIVE_HERMES_CONFIG_UNAVAILABLE_CODE,
  INTERACTIVE_HERMES_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE,
  INTERACTIVE_HERMES_SELECTION_REFUSED_CODE,
  InteractiveHermesSelectionError,
  resolveInteractiveHermesSelection,
  type InteractiveHermesAdapterSource,
  type InteractiveHermesProfileSource,
} from "../../../dist/installer/matchlock/interactive-hermes-selection.js";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";

let base: string;

before(() => {
  base = tamanduaTempDir("mtlk-hermes-sel-");
});

after(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

/** A unique working directory under the test base. */
function mkdir(name: string): string {
  const dir = fs.mkdtempSync(path.join(base, `${name}-`));
  return dir;
}

function baseSubmission(
  overrides: Partial<{ homeDir: string; cwd: string; hermesHomeEnv: string | null }> = {},
): { homeDir: string; cwd: string; hermesHomeEnv: string | null } {
  return { homeDir: base, cwd: base, hermesHomeEnv: null, ...overrides };
}

/** Minimal structural adapter plan for the injected-refusal cases. */
function fakePlan(opts: {
  profile?: Partial<InteractiveHermesProfileSource>;
  selectionRefused?: boolean;
  launchAdmission?: { ok: boolean; code: string | null; reason: string | null };
  hostEffectiveDir?: string;
} = {}): InteractiveHermesAdapterSource {
  const profile: InteractiveHermesProfileSource = {
    profile: "default",
    isNamedProfile: false,
    hostEffectiveDir: "/host/.hermes",
    guestHermesHome: "/workspace/config/hermes",
    guestProfilesRoot: "/workspace/config/hermes/profiles",
    externalDependencies: [],
    outsideScope: false,
    outsideScopeReason: null,
    refused: false,
    refusedReason: null,
    ...opts.profile,
  };
  return {
    profile,
    capturedIdentity: { hostEffectiveDir: opts.hostEffectiveDir ?? profile.hostEffectiveDir },
    selectionRefused: opts.selectionRefused ?? false,
    launchAdmission: opts.launchAdmission ?? { ok: true, code: null, reason: null },
  };
}

function isRefused(err: unknown, code: string): boolean {
  return err instanceof InteractiveHermesSelectionError && err.code === code;
}

describe("US-007 interactive Hermes selection — resolution from frozen inputs", () => {
  it("resolves the default profile from the frozen homeDir and maps the approved guest HERMES_HOME", () => {
    const root = mkdir("default");
    const hermes = path.join(root, ".hermes");
    fs.mkdirSync(hermes, { recursive: true });

    const selection = resolveInteractiveHermesSelection(
      baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: null }),
    );

    assert.equal(selection.profile, "default");
    assert.equal(selection.isNamedProfile, false);
    assert.equal(selection.hostEffectiveDir, hermes);
    assert.equal(selection.guestHermesHome, "/workspace/config/hermes");
    assert.equal(selection.guestProfilesRoot, "/workspace/config/hermes/profiles");
    assert.equal(selection.hermesHomeEnv, null);
    assert.deepEqual(selection.externalDependencies, []);
  });

  it("resolves a named profile from the frozen HERMES_HOME snapshot", () => {
    const root = mkdir("named");
    const profileDir = path.join(root, "profiles", "coder");
    fs.mkdirSync(profileDir, { recursive: true });

    const selection = resolveInteractiveHermesSelection(
      baseSubmission({ homeDir: path.join(root, "home"), cwd: root, hermesHomeEnv: profileDir }),
    );

    assert.equal(selection.profile, "coder");
    assert.equal(selection.isNamedProfile, true);
    assert.equal(selection.hostEffectiveDir, profileDir);
    assert.equal(selection.guestHermesHome, "/workspace/config/hermes/profiles/coder");
    assert.equal(selection.guestProfilesRoot, "/workspace/config/hermes/profiles");
    assert.equal(selection.hermesHomeEnv, profileDir);
  });

  it("resolves the sticky active_profile selection from the frozen homeDir", () => {
    const root = mkdir("sticky");
    const hermes = path.join(root, ".hermes");
    const profileDir = path.join(hermes, "profiles", "writer");
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(hermes, "active_profile"), "writer\n");

    const selection = resolveInteractiveHermesSelection(
      baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: null }),
    );
    assert.equal(selection.profile, "writer");
    assert.equal(selection.hostEffectiveDir, profileDir);
  });

  it("treats a genuinely absent config.yaml under a valid directory as the built-in local default", () => {
    const root = mkdir("absent-config");
    fs.mkdirSync(path.join(root, ".hermes"), { recursive: true });
    const selection = resolveInteractiveHermesSelection(
      baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: null }),
    );
    assert.equal(selection.profile, "default");
  });

  it("does not auto-mount neighbor (required:false) external entries", () => {
    const root = mkdir("neighbors");
    const profiles = path.join(root, "profiles");
    const effective = path.join(profiles, "coder");
    fs.mkdirSync(effective, { recursive: true });
    fs.mkdirSync(path.join(profiles, "other"), { recursive: true });

    const selection = resolveInteractiveHermesSelection(
      baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: effective }),
    );
    const names = selection.externalDependencies.map((dep) => dep.name);
    assert.ok(names.includes("other"), `expected the sibling neighbor, got ${names.join(",")}`);
    for (const dep of selection.externalDependencies) {
      assert.equal(dep.required, false, `${dep.name} must remain a non-required neighbor`);
    }
  });
});

describe("US-007 interactive Hermes selection — typed refusals", () => {
  it("refuses a refused/missing selected profile before any admission", () => {
    const root = mkdir("refused-profile");
    const hermes = path.join(root, ".hermes");
    fs.mkdirSync(hermes, { recursive: true });
    fs.writeFileSync(path.join(hermes, "active_profile"), "ghost\n");

    assert.throws(
      () =>
        resolveInteractiveHermesSelection(
          baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: null }),
        ),
      (err: unknown) =>
        isRefused(err, INTERACTIVE_HERMES_SELECTION_REFUSED_CODE) &&
        /profile "ghost" is refused/.test((err as Error).message),
    );
  });

  it("refuses a reserved profile id selected by active_profile", () => {
    const root = mkdir("reserved-profile");
    const hermes = path.join(root, ".hermes");
    fs.mkdirSync(hermes, { recursive: true });
    fs.writeFileSync(path.join(hermes, "active_profile"), "root\n");

    assert.throws(
      () =>
        resolveInteractiveHermesSelection(
          baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: null }),
        ),
      (err: unknown) => isRefused(err, INTERACTIVE_HERMES_SELECTION_REFUSED_CODE),
    );
  });

  it("refuses a non-local terminal backend and keeps the adapter's bounded code", () => {
    const root = mkdir("remote-backend");
    const effective = path.join(root, "profiles", "ssh");
    fs.mkdirSync(effective, { recursive: true });
    fs.writeFileSync(path.join(effective, "config.yaml"), "terminal:\n  backend: ssh\n");

    assert.throws(
      () =>
        resolveInteractiveHermesSelection(
          baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: effective }),
        ),
      (err: unknown) =>
        isRefused(err, INTERACTIVE_HERMES_SELECTION_REFUSED_CODE) &&
        /terminal-backend-remote/.test((err as Error).message) &&
        /guest-local terminal backend/.test((err as Error).message),
    );
  });

  it("refuses an unrecognized terminal backend", () => {
    const root = mkdir("unknown-backend");
    const effective = path.join(root, ".hermes");
    fs.mkdirSync(effective, { recursive: true });
    fs.writeFileSync(path.join(effective, "config.yaml"), "terminal:\n  backend: k8s\n");

    assert.throws(
      () =>
        resolveInteractiveHermesSelection(
          baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: null }),
        ),
      (err: unknown) =>
        isRefused(err, INTERACTIVE_HERMES_SELECTION_REFUSED_CODE) &&
        /terminal-backend-unknown/.test((err as Error).message),
    );
  });

  it("refuses malformed YAML rather than treating it as the default backend", () => {
    const root = mkdir("malformed");
    const effective = path.join(root, ".hermes");
    fs.mkdirSync(effective, { recursive: true });
    fs.writeFileSync(path.join(effective, "config.yaml"), "terminal: [unclosed\n");

    assert.throws(
      () =>
        resolveInteractiveHermesSelection(
          baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: null }),
        ),
      (err: unknown) =>
        isRefused(err, INTERACTIVE_HERMES_SELECTION_REFUSED_CODE) &&
        /malformed-yaml/.test((err as Error).message),
    );
  });

  it("refuses a config.yaml that is not a regular file", () => {
    const root = mkdir("config-dir");
    const effective = path.join(root, ".hermes");
    fs.mkdirSync(effective, { recursive: true });
    fs.mkdirSync(path.join(effective, "config.yaml"));

    assert.throws(
      () =>
        resolveInteractiveHermesSelection(
          baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: null }),
        ),
      (err: unknown) =>
        isRefused(err, INTERACTIVE_HERMES_SELECTION_REFUSED_CODE) &&
        /not-a-file/.test((err as Error).message),
    );
  });

  it("refuses a missing effective configuration directory with the config-unavailable code", () => {
    const root = mkdir("missing-config");
    const missing = path.join(root, "profiles", "ghost");

    assert.throws(
      () =>
        resolveInteractiveHermesSelection(
          baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: missing }),
        ),
      (err: unknown) =>
        isRefused(err, INTERACTIVE_HERMES_CONFIG_UNAVAILABLE_CODE) &&
        /missing or not a directory/.test((err as Error).message) &&
        /must be mounted read-write at the approved guest HERMES_HOME/.test((err as Error).message) &&
        /broaden the mount scope/.test((err as Error).message),
    );
  });

  it("refuses a configuration source that is a file, not a directory", () => {
    const root = mkdir("config-file");
    const file = path.join(root, "not-a-dir");
    fs.writeFileSync(file, "x");

    assert.throws(
      () =>
        resolveInteractiveHermesSelection(
          baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: file }),
        ),
      (err: unknown) => isRefused(err, INTERACTIVE_HERMES_CONFIG_UNAVAILABLE_CODE),
    );
  });

  it("refuses a REQUIRED external dependency instead of auto-mounting or broadening", () => {
    const plan = fakePlan({
      profile: {
        externalDependencies: [
          {
            kind: "root-store",
            name: "state.db",
            hostPath: "/host/.hermes/state.db",
            required: true,
          },
        ],
      },
    });

    assert.throws(
      () =>
        resolveInteractiveHermesSelection(baseSubmission(), {
          adapterPlan: plan,
          isDirectory: () => true,
        }),
      (err: unknown) =>
        isRefused(err, INTERACTIVE_HERMES_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE) &&
        /root-store:state\.db/.test((err as Error).message) &&
        /never auto-mounts or broadens/.test((err as Error).message),
    );
  });

  it("refuses a selection that escapes the admitted home root rather than broadening", () => {
    const plan = fakePlan({
      profile: {
        outsideScope: true,
        outsideScopeReason: "escapes the root",
      },
    });
    assert.throws(
      () =>
        resolveInteractiveHermesSelection(baseSubmission(), {
          adapterPlan: plan,
          isDirectory: () => true,
        }),
      (err: unknown) =>
        isRefused(err, INTERACTIVE_HERMES_CONFIG_UNAVAILABLE_CODE) &&
        /outside the admitted home root/.test((err as Error).message),
    );
  });

  it("refuses blank frozen inputs rather than resolving from ambient state", () => {
    assert.throws(
      () =>
        resolveInteractiveHermesSelection(baseSubmission({ homeDir: "   " }), {
          adapterPlan: fakePlan(),
          isDirectory: () => true,
        }),
      (err: unknown) => isRefused(err, INTERACTIVE_HERMES_SELECTION_REFUSED_CODE),
    );
    assert.throws(
      () =>
        resolveInteractiveHermesSelection(baseSubmission({ cwd: "" }), {
          adapterPlan: fakePlan(),
          isDirectory: () => true,
        }),
      (err: unknown) => isRefused(err, INTERACTIVE_HERMES_SELECTION_REFUSED_CODE),
    );
  });
});

describe("US-007 interactive Hermes selection — determinism and purity", () => {
  it("returns a deep-equal selection across repeated calls", () => {
    const root = mkdir("determinism");
    fs.mkdirSync(path.join(root, ".hermes"), { recursive: true });
    const submission = baseSubmission({ homeDir: root, cwd: root, hermesHomeEnv: null });
    assert.deepEqual(
      resolveInteractiveHermesSelection(submission),
      resolveInteractiveHermesSelection(submission),
    );
  });

  it("source imports no child_process (pure, unit-testable)", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/installer/matchlock/interactive-hermes-selection.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /(?:from|import)\s*\(?\s*["'](?:node:)?child_process["']/);
  });
});
