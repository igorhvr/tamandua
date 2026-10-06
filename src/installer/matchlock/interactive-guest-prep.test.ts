/**
 * US-006 — interactive guest preparation planner (GAP-05).
 *
 * Pure planner tests: no VM, no spawn, no child_process (parallel lane). The
 * planner is driven through its injectable "facts" seam so the passwd/group
 * absence branches, HOME/parent-dir creation, host-mount boundaries, typed
 * refusals and launch environment are all exercised deterministically.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  INTERACTIVE_GUEST_CONFIG_UNAVAILABLE_CODE,
  INTERACTIVE_GUEST_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE,
  INTERACTIVE_GUEST_GROUP_NAME,
  INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE,
  INTERACTIVE_GUEST_PREP_REJECTED_CODE,
  INTERACTIVE_GUEST_USER_NAME,
  InteractiveGuestPrepError,
  defaultInteractiveGuestHome,
  planInteractiveGuestPrep,
  type InteractiveGuestFacts,
  type PlanInteractiveGuestPrepInput,
} from "../../../dist/installer/matchlock/interactive-guest-prep.js";

const ABSENT_FACTS: InteractiveGuestFacts = {
  passwdUids: [1000],
  groupGids: [1000],
  existingDirs: ["/srv", "/workspace", "/workspace/config", "/home"],
  imagePath: "/usr/local/bin:/usr/bin:/bin",
  term: "xterm-256color",
  binary: { path: "/usr/local/bin/pi", runnableAsUser: true },
  externalDependencies: [],
};

const PRESENT_FACTS: InteractiveGuestFacts = {
  ...ABSENT_FACTS,
  passwdUids: [4242],
  groupGids: [4343],
};

function baseInput(
  overrides: Partial<PlanInteractiveGuestPrepInput> = {},
): PlanInteractiveGuestPrepInput {
  return {
    harness: "pi",
    shell: false,
    identity: { uid: 4242, gid: 4343, hostHomeDir: "/home/operator" },
    guestWorkingDirectory: "/srv/project",
    guestConfigurationRoot: "/workspace/config/pi",
    hostConfigurationRoot: "/home/operator/.pi/agent",
    guestHome: "/home/tamandua",
    hostMountDestinations: ["/srv/project", "/workspace/config/pi"],
    facts: ABSENT_FACTS,
    ...overrides,
  };
}

function commandById(
  plan: ReturnType<typeof planInteractiveGuestPrep>,
  id: string,
) {
  return plan.commands.find((entry) => entry.id === id);
}

describe("interactive guest prep — passwd/group mapping (acceptance 1)", () => {
  it("maps the numeric uid/gid into passwd and group entries when absent", () => {
    const plan = planInteractiveGuestPrep(baseInput({ facts: ABSENT_FACTS }));
    const groupadd = commandById(plan, "groupadd");
    const useradd = commandById(plan, "useradd");
    assert.ok(groupadd, "absent gid must emit a group entry");
    assert.ok(useradd, "absent uid must emit a passwd entry");
    assert.equal(groupadd.command, `groupadd --gid 4343 ${INTERACTIVE_GUEST_GROUP_NAME}`);
    assert.match(useradd.command, /--uid 4242 /);
    assert.match(useradd.command, /--gid 4343 /);
    assert.match(useradd.command, new RegExp(`--home-dir /home/tamandua `));
    assert.match(useradd.command, new RegExp(`--no-create-home --shell /bin/sh ${INTERACTIVE_GUEST_USER_NAME}$`));
  });

  it("orders the group entry before the passwd entry", () => {
    const plan = planInteractiveGuestPrep(baseInput({ facts: ABSENT_FACTS }));
    const ids = plan.commands.map((entry) => entry.id);
    assert.ok(ids.indexOf("groupadd") < ids.indexOf("useradd"));
  });

  it("emits NO passwd/group entry when both are already present", () => {
    const plan = planInteractiveGuestPrep(baseInput({ facts: PRESENT_FACTS }));
    assert.equal(commandById(plan, "groupadd"), undefined);
    assert.equal(commandById(plan, "useradd"), undefined);
  });

  it("emits only the missing entry (gid absent, uid present)", () => {
    const plan = planInteractiveGuestPrep(
      baseInput({ facts: { ...ABSENT_FACTS, passwdUids: [4242] } }),
    );
    assert.ok(commandById(plan, "groupadd"));
    assert.equal(commandById(plan, "useradd"), undefined);
  });

  it("emits only the missing entry (uid absent, gid present)", () => {
    const plan = planInteractiveGuestPrep(
      baseInput({ facts: { ...ABSENT_FACTS, groupGids: [4343] } }),
    );
    assert.equal(commandById(plan, "groupadd"), undefined);
    const useradd = commandById(plan, "useradd");
    assert.ok(useradd);
    assert.match(useradd.command, /--uid 4242 /);
    assert.match(useradd.command, /--gid 4343 /);
  });

  it("never rewrites an existing numeric entry, whatever the name", () => {
    const plan = planInteractiveGuestPrep(
      baseInput({ facts: { ...ABSENT_FACTS, passwdUids: [4242], groupGids: [4343] } }),
    );
    for (const entry of plan.commands) {
      assert.doesNotMatch(entry.command, /\b(?:useradd|groupadd)\b/);
    }
  });
});

describe("interactive guest prep — HOME and parent directories (acceptance 2)", () => {
  it("creates a writable guest-local HOME owned by the selected identity", () => {
    const plan = planInteractiveGuestPrep(baseInput());
    const home = commandById(plan, "create_home");
    assert.ok(home, "missing HOME must be created");
    assert.equal(home.target, "/home/tamandua");
    assert.equal(home.command, `install -d -m 0700 -o 4242 -g 4343 /home/tamandua`);
    assert.equal(home.privileged, true);
  });

  it("does not recreate an existing HOME", () => {
    const plan = planInteractiveGuestPrep(
      baseInput({ facts: { ...ABSENT_FACTS, existingDirs: [...ABSENT_FACTS.existingDirs!, "/home/tamandua"] } }),
    );
    assert.equal(commandById(plan, "create_home"), undefined);
  });

  it("creates only MISSING parent directories, top-down", () => {
    const plan = planInteractiveGuestPrep(
      baseInput({
        facts: { ...ABSENT_FACTS, existingDirs: ["/srv", "/workspace", "/home"] },
        guestWorkingDirectory: "/deep/nested/project",
        guestConfigurationRoot: "/workspace/config/hermes",
        harness: "hermes",
      }),
    );
    const dirs = plan.commands
      .filter((entry) => entry.id === "create_parent_dir")
      .map((entry) => entry.target);
    assert.deepEqual(dirs, ["/deep", "/deep/nested", "/workspace/config"]);
    assert.ok(!dirs!.includes("/srv"), "an existing dir must not be recreated");
    assert.ok(!dirs!.includes("/workspace"), "an existing dir must not be recreated");
  });

  it("never targets a host-mount destination and never names one in a command", () => {
    const plan = planInteractiveGuestPrep(baseInput());
    for (const entry of plan.commands) {
      assert.notEqual(entry.target, "/srv/project");
      assert.notEqual(entry.target, "/workspace/config/pi");
      assert.doesNotMatch(entry.command, /\/srv\/project(\s|$)/);
      assert.doesNotMatch(entry.command, /\/workspace\/config\/pi(\s|$)/);
    }
  });

  it("refuses a HOME that is, or lives inside, a host mount", () => {
    assert.throws(
      () => planInteractiveGuestPrep(baseInput({ guestHome: "/srv/project/home" })),
      (err: unknown) =>
        err instanceof InteractiveGuestPrepError &&
        err.code === INTERACTIVE_GUEST_PREP_REJECTED_CODE &&
        /host mount/.test(err.message),
    );
  });

  it("defaults the guest HOME to /root for uid 0 and /home/u<uid> otherwise", () => {
    assert.equal(defaultInteractiveGuestHome(0), "/root");
    assert.equal(defaultInteractiveGuestHome(4242), "/home/u4242");
    const plan = planInteractiveGuestPrep(
      baseInput({ identity: { uid: 0, gid: 0 }, guestHome: undefined }),
    );
    assert.equal(plan.guestHome, "/root");
    const home = commandById(plan, "create_home");
    assert.equal(home?.command, "install -d -m 0700 -o 0 -g 0 /root");
  });
});

describe("interactive guest prep — no recursive ownership (acceptance 3)", () => {
  it("emits no chown/chmod and no recursive flag for any variant", () => {
    for (const harness of ["pi", "hermes"] as const) {
      for (const shell of [false, true]) {
        const plan = planInteractiveGuestPrep(
          baseInput({
            harness,
            shell,
            guestConfigurationRoot: harness === "hermes" ? "/workspace/config/hermes" : "/workspace/config/pi",
            facts: {
              ...ABSENT_FACTS,
              binary: { path: `/usr/local/bin/${shell ? "zsh" : harness}`, runnableAsUser: true },
            },
          }),
        );
        for (const entry of plan.commands) {
          assert.doesNotMatch(entry.command, /\b(?:chown|chmod)\b/, entry.command);
          assert.doesNotMatch(entry.command, /(?:^|\s)(?:-R|--recursive)(?:\s|$)/, entry.command);
        }
      }
    }
  });

  it("applies ownership at creation with install -d only", () => {
    const plan = planInteractiveGuestPrep(baseInput());
    for (const entry of plan.commands) {
      if (entry.id === "create_home" || entry.id === "create_parent_dir") {
        assert.match(entry.command, /^install -d /, entry.command);
        assert.match(entry.command, /-o 4242 -g 4343 /);
      }
    }
  });
});

describe("interactive guest prep — typed refusals (acceptance 4)", () => {
  it("refuses a missing captured configuration with a typed code", () => {
    for (const hostConfigurationRoot of [undefined, null, "", "   "]) {
      assert.throws(
        () => planInteractiveGuestPrep(baseInput({ hostConfigurationRoot })),
        (err: unknown) =>
          err instanceof InteractiveGuestPrepError &&
          err.code === INTERACTIVE_GUEST_CONFIG_UNAVAILABLE_CODE,
      );
    }
  });

  it("refuses an unsupported REQUIRED external dependency and names it", () => {
    assert.throws(
      () =>
        planInteractiveGuestPrep(
          baseInput({
            facts: {
              ...ABSENT_FACTS,
              externalDependencies: [
                { name: "root-store:state.db", required: true, detail: "outside profile" },
              ],
            },
          }),
        ),
      (err: unknown) =>
        err instanceof InteractiveGuestPrepError &&
        err.code === INTERACTIVE_GUEST_EXTERNAL_DEPENDENCY_UNSUPPORTED_CODE &&
        /root-store:state\.db/.test(err.message) &&
        /never broadened|broadened/.test(err.message),
    );
  });

  it("does not refuse a NON-required neighboring external entry", () => {
    const plan = planInteractiveGuestPrep(
      baseInput({
        facts: {
          ...ABSENT_FACTS,
          externalDependencies: [{ name: "sibling-profile:other", required: false }],
        },
      }),
    );
    assert.ok(plan.commands.length > 0);
  });

  it("refuses an absent image harness with a typed code", () => {
    assert.throws(
      () => planInteractiveGuestPrep(baseInput({ facts: { ...ABSENT_FACTS, binary: { path: null, runnableAsUser: true } } })),
      (err: unknown) =>
        err instanceof InteractiveGuestPrepError && err.code === INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE,
    );
  });

  it("refuses an image harness that is not runnable as the selected user", () => {
    assert.throws(
      () =>
        planInteractiveGuestPrep(
          baseInput({ facts: { ...ABSENT_FACTS, binary: { path: "/usr/local/bin/pi", runnableAsUser: false } } }),
        ),
      (err: unknown) =>
        err instanceof InteractiveGuestPrepError &&
        err.code === INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE &&
        /4242:4343/.test(err.message) &&
        /no automatic installation and no root retry/.test(err.message),
    );
  });

  it("refuses when the binary capability was never confirmed (fail closed)", () => {
    assert.throws(
      () => planInteractiveGuestPrep(baseInput({ facts: { ...ABSENT_FACTS, binary: undefined } })),
      (err: unknown) =>
        err instanceof InteractiveGuestPrepError && err.code === INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE,
    );
  });

  it("names zsh for a shell variant whose binary is absent", () => {
    assert.throws(
      () => planInteractiveGuestPrep(baseInput({ shell: true, facts: { ...ABSENT_FACTS, binary: { path: null, runnableAsUser: true } } })),
      (err: unknown) =>
        err instanceof InteractiveGuestPrepError &&
        err.code === INTERACTIVE_GUEST_HARNESS_UNUSABLE_CODE &&
        /\bzsh\b/.test(err.message),
    );
  });

  it("refuses non-integer / negative identity and malformed guest paths", () => {
    assert.throws(
      () => planInteractiveGuestPrep(baseInput({ identity: { uid: 1.5, gid: 1 } })),
      (err: unknown) => err instanceof InteractiveGuestPrepError && err.code === INTERACTIVE_GUEST_PREP_REJECTED_CODE,
    );
    assert.throws(
      () => planInteractiveGuestPrep(baseInput({ identity: { uid: 1, gid: -1 } })),
      (err: unknown) => err instanceof InteractiveGuestPrepError && err.code === INTERACTIVE_GUEST_PREP_REJECTED_CODE,
    );
    assert.throws(
      () => planInteractiveGuestPrep(baseInput({ guestConfigurationRoot: "relative/path" })),
      (err: unknown) => err instanceof InteractiveGuestPrepError && err.code === INTERACTIVE_GUEST_PREP_REJECTED_CODE,
    );
    assert.throws(
      () => planInteractiveGuestPrep(baseInput({ guestHome: "/home/../etc" })),
      (err: unknown) => err instanceof InteractiveGuestPrepError && err.code === INTERACTIVE_GUEST_PREP_REJECTED_CODE,
    );
  });
});

describe("interactive guest prep — launch environment", () => {
  it("sets HOME and the pi configuration override", () => {
    const plan = planInteractiveGuestPrep(baseInput());
    assert.equal(plan.env.HOME, "/home/tamandua");
    assert.equal(plan.env.PI_CODING_AGENT_DIR, "/workspace/config/pi");
    assert.equal("HERMES_HOME" in plan.env, false);
  });

  it("sets HOME and the hermes configuration override", () => {
    const plan = planInteractiveGuestPrep(
      baseInput({
        harness: "hermes",
        guestConfigurationRoot: "/workspace/config/hermes",
        hostMountDestinations: ["/srv/project", "/workspace/config/hermes"],
        facts: { ...ABSENT_FACTS, binary: { path: "/usr/local/bin/hermes", runnableAsUser: true } },
      }),
    );
    assert.equal(plan.env.HOME, "/home/tamandua");
    assert.equal(plan.env.HERMES_HOME, "/workspace/config/hermes");
    assert.equal("PI_CODING_AGENT_DIR" in plan.env, false);
  });

  it("preserves the image PATH verbatim and never substitutes a host default", () => {
    const plan = planInteractiveGuestPrep(baseInput());
    assert.equal(plan.env.PATH, "/usr/local/bin:/usr/bin:/bin");
    const noPath = planInteractiveGuestPrep(
      baseInput({ facts: { ...ABSENT_FACTS, imagePath: null } }),
    );
    assert.equal("PATH" in noPath.env, false);
  });

  it("forwards only terminal settings when present", () => {
    const plan = planInteractiveGuestPrep(baseInput());
    assert.equal(plan.env.TERM, "xterm-256color");
    const noTerm = planInteractiveGuestPrep(
      baseInput({ facts: { ...ABSENT_FACTS, term: null, colorTerm: null } }),
    );
    assert.equal("TERM" in noTerm.env, false);
    assert.equal("COLORTERM" in noTerm.env, false);
  });

  it("never imports the captured host HOME into the environment", () => {
    const plan = planInteractiveGuestPrep(baseInput());
    for (const value of Object.values(plan.env)) {
      assert.ok(!value.startsWith("/home/operator"), value);
    }
  });
});

describe("interactive guest prep — D6 mount-aware host-HOME guards", () => {
  it("accepts a consented exact root override with guest HOME=/root when no host-HOME mount exists", () => {
    const plan = planInteractiveGuestPrep(
      baseInput({
        identity: { uid: 0, gid: 0, hostHomeDir: "/root" },
        guestHome: undefined,
        guestConfigurationRoot: "/workspace/config/pi",
        hostMountDestinations: [],
        facts: {
          ...ABSENT_FACTS,
          binary: { path: "/usr/local/bin/pi", runnableAsUser: true },
        },
      }),
    );
    assert.equal(plan.guestHome, "/root");
    assert.equal(plan.env.HOME, "/root");
    assert.equal(plan.env.PI_CODING_AGENT_DIR, "/workspace/config/pi");
    const home = commandById(plan, "create_home");
    assert.ok(home, "guest-local /root must still be created");
    assert.equal(home.target, "/root");
  });

  it("still refuses guest HOME=/root when the host HOME is an actual host mount", () => {
    assert.throws(
      () =>
        planInteractiveGuestPrep(
          baseInput({
            identity: { uid: 0, gid: 0, hostHomeDir: "/root" },
            guestHome: undefined,
            hostMountDestinations: ["/root"],
            hostConfigurationRoot: "/root/.pi/agent",
          }),
        ),
      (err: unknown) =>
        err instanceof InteractiveGuestPrepError &&
        err.code === INTERACTIVE_GUEST_PREP_REJECTED_CODE &&
        /host mount/.test(err.message),
    );
  });

  it("accepts an identical config path nested under the host HOME (D5 interaction) for a non-root caller", () => {
    const plan = planInteractiveGuestPrep(
      baseInput({
        identity: { uid: 4242, gid: 4343, hostHomeDir: "/home/operator" },
        guestHome: "/home/u4242",
        guestConfigurationRoot: "/home/operator/.pi/agent",
        hostConfigurationRoot: "/home/operator/.pi/agent",
        hostMountDestinations: ["/srv/project", "/home/operator/.pi/agent"],
      }),
    );
    assert.equal(plan.env.HOME, "/home/u4242");
    assert.equal(plan.env.PI_CODING_AGENT_DIR, "/home/operator/.pi/agent");
  });
});

describe("interactive guest prep — determinism and purity", () => {
  it("returns a deep-equal plan across repeated calls", () => {
    assert.deepEqual(planInteractiveGuestPrep(baseInput()), planInteractiveGuestPrep(baseInput()));
  });

  it("keeps a deterministic command id order", () => {
    const ids = planInteractiveGuestPrep(baseInput()).commands.map((entry) => entry.id);
    assert.deepEqual(ids, ["groupadd", "useradd", "create_home"]);
  });

  it("planner source imports no child_process (pure, unit-testable)", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/installer/matchlock/interactive-guest-prep.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /(?:from|import)\s*\(?\s*["'](?:node:)?child_process["']/);
  });
});
