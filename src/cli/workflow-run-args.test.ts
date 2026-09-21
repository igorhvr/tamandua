import { describe, it } from "node:test";
import assert from "node:assert";
import { parseWorkflowRunArgs, parseWorkdirCollisionPolicyFlags } from "../../dist/cli/workflow-run-args.js";
import { writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("parseWorkflowRunArgs", () => {
  it("parses task only", () => {
    const result = parseWorkflowRunArgs(["Do something"]);
    assert.equal(result.taskTitle, "Do something");
    assert.deepEqual(result.context, {});
  });

  it("parses --context with single key=value", () => {
    const result = parseWorkflowRunArgs(["Some task", "--context", "branch=feature/x"]);
    assert.equal(result.taskTitle, "Some task");
    assert.deepEqual(result.context, { branch: "feature/x" });
  });

  it("parses --context with value containing =", () => {
    const result = parseWorkflowRunArgs(["task", "--context", "url=http://example.com?a=b&c=d"]);
    assert.deepEqual(result.context, { url: "http://example.com?a=b&c=d" });
  });

  it("parses multiple --context flags", () => {
    const result = parseWorkflowRunArgs([
      "Multi context",
      "--context", "branch=fix/bug",
      "--context", "env=staging",
      "--context", "repo=/tmp/repo",
    ]);
    assert.deepEqual(result.context, {
      branch: "fix/bug",
      env: "staging",
      repo: "/tmp/repo",
    });
  });

  it("rejects --context with missing =", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context", "novalueseparator"]),
      /must contain '='/,
    );
  });

  it("rejects --context with empty key", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context", "=value"]),
      /key must be non-empty/,
    );
  });

  it("rejects duplicate --context keys", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context", "branch=a", "--context", "branch=b"]),
      /Duplicate --context key "branch"/,
    );
  });

  it("rejects --context with missing value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--context"]),
      /Missing value for --context/,
    );
  });

  it("parses context alongside other flags", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--context", "branch=quarantine/broken-tests",
      "Quarantine broken tests",
      "--context", "repo=/tmp/myapp",
    ]);
    assert.equal(result.taskTitle, "Quarantine broken tests");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.deepEqual(result.context, {
      branch: "quarantine/broken-tests",
      repo: "/tmp/myapp",
    });
  });

  it("parses empty context when no --context flags provided", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--worktree-origin-repository", "/tmp/repo",
      "Build feature",
    ]);
    assert.equal(result.taskTitle, "Build feature");
    assert.deepEqual(result.context, {});
    assert.equal(result.worktreeOriginRepository, "/tmp/repo");
  });

  it("parses --wait flag", () => {
    const result = parseWorkflowRunArgs(["Do something", "--wait"]);
    assert.equal(result.wait, true);
    assert.equal(result.jsonFlag, false);
    assert.equal(result.timeout, undefined);
  });

  it("wait is false by default", () => {
    const result = parseWorkflowRunArgs(["Do something"]);
    assert.equal(result.wait, false);
    assert.equal(result.jsonFlag, false);
    assert.equal(result.timeout, undefined);
  });

  it("parses --timeout <duration>", () => {
    const result = parseWorkflowRunArgs(["Do something", "--wait", "--timeout", "30s"]);
    assert.equal(result.wait, true);
    assert.equal(result.timeout, "30s");
  });

  it("parses --timeout=<duration>", () => {
    const result = parseWorkflowRunArgs(["Do something", "--wait", "--timeout=10m"]);
    assert.equal(result.wait, true);
    assert.equal(result.timeout, "10m");
  });

  it("parses --json flag", () => {
    const result = parseWorkflowRunArgs(["Do something", "--wait", "--json"]);
    assert.equal(result.wait, true);
    assert.equal(result.jsonFlag, true);
  });

  it("parses --wait, --timeout, and --json together", () => {
    const result = parseWorkflowRunArgs(["Do something", "--wait", "--timeout", "2h", "--json"]);
    assert.equal(result.wait, true);
    assert.equal(result.timeout, "2h");
    assert.equal(result.jsonFlag, true);
  });

  it("--wait does not affect task title", () => {
    const result = parseWorkflowRunArgs(["My task description", "--wait", "--timeout", "90s"]);
    assert.equal(result.taskTitle, "My task description");
  });

  it("--json without --wait is parsed correctly", () => {
    const result = parseWorkflowRunArgs(["Do something", "--json"]);
    assert.equal(result.wait, false);
    assert.equal(result.jsonFlag, true);
  });

  it("--wait combined with other flags preserves them", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "--wait",
      "--timeout", "5m",
      "--context", "branch=fix/x",
      "Build feature",
    ]);
    assert.equal(result.wait, true);
    assert.equal(result.timeout, "5m");
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.deepEqual(result.context, { branch: "fix/x" });
    assert.equal(result.taskTitle, "Build feature");
  });

  it("rejects --timeout with missing value", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--timeout"]),
      /Missing value for --timeout/,
    );
  });

  // US-001: Unknown flag rejection
  it("rejects unknown --flag", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["some task", "--unknown-flag", "value"]),
      /Unknown option "--unknown-flag" for workflow run/,
    );
  });

  it("rejects unknown -u short flag", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "-u"]),
      /Unknown option "-u" for workflow run/,
    );
  });

  it("rejects unknown -X short flag", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "-X"]),
      /Unknown option "-X" for workflow run/,
    );
  });

  it("allows bare - as task text", () => {
    const result = parseWorkflowRunArgs(["task", "-", "and-more"]);
    assert.equal(result.taskTitle, "task - and-more");
  });

  it("allows negative numbers as task text", () => {
    const result = parseWorkflowRunArgs(["task", "-42"]);
    assert.equal(result.taskTitle, "task -42");
  });

  it("allows -- separator: everything after goes verbatim to task title", () => {
    const result = parseWorkflowRunArgs(["task", "--", "--still-task", "-x", "--more-flags"]);
    assert.equal(result.taskTitle, "task --still-task -x --more-flags");
  });

  it("-- separator: prefixing task words are preserved", () => {
    const result = parseWorkflowRunArgs(["my task", "--", "--pretend-flag"]);
    assert.equal(result.taskTitle, "my task --pretend-flag");
  });

  it("-- separator: recognized flags after -- become task text", () => {
    const result = parseWorkflowRunArgs(["task", "--", "--wait", "--json"]);
    assert.equal(result.taskTitle, "task --wait --json");
    assert.equal(result.wait, false);
    assert.equal(result.jsonFlag, false);
  });

  it("-- separator with recognized flags before -- still works", () => {
    const result = parseWorkflowRunArgs([
      "--no-hurry-please-save-tokens-mode",
      "my task",
      "--",
      "--unknown-flag",
    ]);
    assert.equal(result.noHurrySaveTokensMode, true);
    assert.equal(result.taskTitle, "my task --unknown-flag");
  });

  it("rejects unknown --flag before -- separator", () => {
    assert.throws(
      () => parseWorkflowRunArgs(["task", "--bad-flag", "--", "after-sep"]),
      /Unknown option "--bad-flag" for workflow run/,
    );
  });

  // US-007: --task-file flag
  describe("--task-file", () => {
    it("reads task from file and uses contents as taskTitle", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tamandua-test-"));
      const taskPath = join(tmpDir, "task.md");
      writeFileSync(taskPath, "Build a dark mode toggle\n\nWith accessibility support.", "utf-8");
      try {
        const result = parseWorkflowRunArgs(["--task-file", taskPath]);
        assert.equal(result.taskTitle, "Build a dark mode toggle\n\nWith accessibility support.");
      } finally {
        unlinkSync(taskPath);
      }
    });

    it("--task-file and inline task words are mutually exclusive", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["--task-file", "task.md", "inline task here"]),
        /--task-file is mutually exclusive with inline task text/,
      );
    });

    it("missing/unreadable --task-file throws error", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["--task-file", "/nonexistent/path/task.md"]),
        /Cannot read --task-file/,
      );
    });

    it("--task-file value missing throws error", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["--task-file"]),
        /Missing value for --task-file/,
      );
    });

    it("--task-file=path syntax works", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tamandua-test-"));
      const taskPath = join(tmpDir, "task.md");
      writeFileSync(taskPath, "Task from equals syntax.", "utf-8");
      try {
        const result = parseWorkflowRunArgs(["--task-file=" + taskPath]);
        assert.equal(result.taskTitle, "Task from equals syntax.");
      } finally {
        unlinkSync(taskPath);
      }
    });

    it("provenance: file path NOT stored in taskTitle", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tamandua-test-"));
      const taskPath = join(tmpDir, "task.md");
      writeFileSync(taskPath, "The actual task content", "utf-8");
      try {
        const result = parseWorkflowRunArgs(["--task-file", taskPath]);
        // taskTitle should be the file CONTENTS, not the path
        assert.equal(result.taskTitle, "The actual task content");
        assert.ok(!result.taskTitle.includes(taskPath));
        assert.ok(!result.taskTitle.includes("task.md"));
      } finally {
        unlinkSync(taskPath);
      }
    });

    it("provenance: file deleted after invocation — task content preserved", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tamandua-test-"));
      const taskPath = join(tmpDir, "task.md");
      writeFileSync(taskPath, "Preserved task content", "utf-8");
      let taskTitle: string;
      try {
        taskTitle = parseWorkflowRunArgs(["--task-file", taskPath]).taskTitle;
      } finally {
        // Delete after parsing completes — contents already captured
        unlinkSync(taskPath);
      }
      assert.equal(taskTitle, "Preserved task content");
      // File no longer exists, but taskTitle is preserved
    });

    it("empty file produces empty taskTitle", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tamandua-test-"));
      const taskPath = join(tmpDir, "task.md");
      writeFileSync(taskPath, "", "utf-8");
      try {
        const result = parseWorkflowRunArgs(["--task-file", taskPath]);
        assert.equal(result.taskTitle, "");
      } finally {
        unlinkSync(taskPath);
      }
    });

    it("--task-file works with other flags", () => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tamandua-test-"));
      const taskPath = join(tmpDir, "task.md");
      writeFileSync(taskPath, "Task with other flags", "utf-8");
      try {
        const result = parseWorkflowRunArgs([
          "--no-hurry-please-save-tokens-mode",
          "--task-file", taskPath,
          "--context", "branch=fix/x",
          "--wait",
          "--timeout", "5m",
        ]);
        assert.equal(result.taskTitle, "Task with other flags");
        assert.equal(result.noHurrySaveTokensMode, true);
        assert.deepEqual(result.context, { branch: "fix/x" });
        assert.equal(result.wait, true);
        assert.equal(result.timeout, "5m");
      } finally {
        unlinkSync(taskPath);
      }
    });

    it("--task-file is rejected before -- separator", () => {
      // --task-file should be recognized and file read; anything after --
      // is considered inline task text, triggering mutual exclusion
      const tmpDir = mkdtempSync(join(tmpdir(), "tamandua-test-"));
      const taskPath = join(tmpDir, "task.md");
      writeFileSync(taskPath, "File task", "utf-8");
      try {
        assert.throws(
          () => parseWorkflowRunArgs(["--task-file", taskPath, "--", "extra", "words"]),
          /--task-file is mutually exclusive with inline task text/,
        );
      } finally {
        unlinkSync(taskPath);
      }
    });
  });

  // WORKDIR-FLAGS US-002: queue/allow flag parsing + env mapping.
  describe("workdir collision policy", () => {
    const ENV_VAR = "TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR";

    function withEnv<T>(value: string | undefined, fn: () => T): T {
      const previous = process.env[ENV_VAR];
      if (value === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = value;
      try {
        return fn();
      } finally {
        if (previous === undefined) delete process.env[ENV_VAR];
        else process.env[ENV_VAR] = previous;
      }
    }

    it("defaults to refuse with no flag and no env", () => {
      withEnv(undefined, () => {
        const result = parseWorkflowRunArgs(["Do something"]);
        assert.equal(result.workdirCollisionPolicy, "refuse");
      });
    });

    it("parses --queue-behind-holder as queue", () => {
      withEnv(undefined, () => {
        const result = parseWorkflowRunArgs(["Do something", "--queue-behind-holder"]);
        assert.equal(result.workdirCollisionPolicy, "queue");
        assert.equal(result.taskTitle, "Do something");
      });
    });

    it("parses --allow-multiple-runs-in-one-working-directory as allow", () => {
      withEnv(undefined, () => {
        const result = parseWorkflowRunArgs([
          "Do something",
          "--allow-multiple-runs-in-one-working-directory",
        ]);
        assert.equal(result.workdirCollisionPolicy, "allow");
      });
    });

    it("rejects both flags together, naming both", () => {
      withEnv(undefined, () => {
        assert.throws(
          () =>
            parseWorkflowRunArgs([
              "task",
              "--queue-behind-holder",
              "--allow-multiple-runs-in-one-working-directory",
            ]),
          (err: unknown) => {
            const message = (err as Error).message;
            return (
              message.includes("--queue-behind-holder") &&
              message.includes("--allow-multiple-runs-in-one-working-directory")
            );
          },
        );
      });
    });

    it("rejects both flags together in reverse order, naming both", () => {
      withEnv(undefined, () => {
        assert.throws(
          () =>
            parseWorkflowRunArgs([
              "task",
              "--allow-multiple-runs-in-one-working-directory",
              "--queue-behind-holder",
            ]),
          (err: unknown) => {
            const message = (err as Error).message;
            return (
              message.includes("--queue-behind-holder") &&
              message.includes("--allow-multiple-runs-in-one-working-directory")
            );
          },
        );
      });
    });

    it("env TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR=1 alone resolves to allow", () => {
      withEnv("1", () => {
        const result = parseWorkflowRunArgs(["Do something"]);
        assert.equal(result.workdirCollisionPolicy, "allow");
      });
    });

    it("explicit queue flag overrides the env allow form", () => {
      withEnv("1", () => {
        const result = parseWorkflowRunArgs(["Do something", "--queue-behind-holder"]);
        assert.equal(result.workdirCollisionPolicy, "queue");
      });
    });

    it("env values other than 1 do not enable allow", () => {
      withEnv("true", () => {
        const result = parseWorkflowRunArgs(["Do something"]);
        assert.equal(result.workdirCollisionPolicy, "refuse");
      });
    });

    // WORKDIR-FLAGS US-005: `workflow resume` reuses the same parser, so the
    // shared helper must resolve identically to parseWorkflowRunArgs.
    it("parseWorkdirCollisionPolicyFlags resolves queue/allow/refuse like parseWorkflowRunArgs", () => {
      withEnv(undefined, () => {
        assert.equal(parseWorkdirCollisionPolicyFlags(["--queue-behind-holder"]), "queue");
        assert.equal(
          parseWorkdirCollisionPolicyFlags([
            "--allow-multiple-runs-in-one-working-directory",
          ]),
          "allow",
        );
        assert.equal(parseWorkdirCollisionPolicyFlags(["resume", "run-abc"]), "refuse");
      });
    });

    it("parseWorkdirCollisionPolicyFlags honors the env allow form", () => {
      withEnv("1", () => {
        assert.equal(parseWorkdirCollisionPolicyFlags(["run-abc"]), "allow");
      });
      withEnv("1", () => {
        assert.equal(
          parseWorkdirCollisionPolicyFlags(["run-abc", "--queue-behind-holder"]),
          "queue",
        );
      });
    });

    it("parseWorkdirCollisionPolicyFlags rejects both flags together", () => {
      withEnv(undefined, () => {
        assert.throws(
          () =>
            parseWorkdirCollisionPolicyFlags([
              "--queue-behind-holder",
              "--allow-multiple-runs-in-one-working-directory",
            ]),
          /--queue-behind-holder/,
        );
      });
    });

    it("parseWorkdirCollisionPolicyFlags ignores flags after --", () => {
      withEnv(undefined, () => {
        assert.equal(
          parseWorkdirCollisionPolicyFlags(["run-abc", "--", "--queue-behind-holder"]),
          "refuse",
        );
      });
    });
  });

  // MTLK-PI US-001: `--matchlock` opt-in parsing.
  describe("--matchlock", () => {
    it("parses --matchlock IMAGE (space form)", () => {
      const result = parseWorkflowRunArgs(["Build feature", "--matchlock", "vic/ml:latest"]);
      assert.equal(result.matchlockImage, "vic/ml:latest");
      assert.equal(result.taskTitle, "Build feature");
    });

    it("parses --matchlock=IMAGE (equals form)", () => {
      const result = parseWorkflowRunArgs(["Build feature", "--matchlock=vic/ml:latest"]);
      assert.equal(result.matchlockImage, "vic/ml:latest");
      assert.equal(result.taskTitle, "Build feature");
    });

    it("matchlockImage is undefined when --matchlock is absent", () => {
      const result = parseWorkflowRunArgs(["Build feature"]);
      assert.equal(result.matchlockImage, undefined);
    });

    it("rejects --matchlock with a missing value (flag at end)", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["Build feature", "--matchlock"]),
        /Missing value for --matchlock/,
      );
    });

    it("rejects --matchlock= (empty value)", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["Build feature", "--matchlock="]),
        /Missing value for --matchlock/,
      );
    });

    it("rejects a duplicate --matchlock", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["--matchlock", "a", "--matchlock", "b"]),
        /Duplicate --matchlock/,
      );
    });

    it("rejects a duplicate via mixed forms", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["--matchlock=a", "--matchlock=b"]),
        /Duplicate --matchlock/,
      );
    });

    it("rejects a value that is another recognized --flag (never consumes it)", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["--matchlock", "--pi-as-harness"]),
        /is an option, not an image/,
      );
    });

    it("allows --matchlock with explicit --pi-as-harness", () => {
      const result = parseWorkflowRunArgs([
        "task",
        "--matchlock", "vic/ml:latest",
        "--pi-as-harness",
      ]);
      assert.equal(result.matchlockImage, "vic/ml:latest");
      assert.equal(result.harnessAs, "pi");
    });

    it("allows --matchlock combined with --hermes-as-harness", () => {
      const result = parseWorkflowRunArgs(["task", "--matchlock", "vic/ml", "--hermes-as-harness"]);
      assert.equal(result.matchlockImage, "vic/ml");
      assert.equal(result.harnessAs, "hermes");
    });

    it("allows --matchlock combined with --hermes-as-harness (hermes first) — union supersedes the pi+dsh refusal", () => {
      // MTLK-DSH-EXEC union MTLK-HERMES-EXEC: the pi+dsh slice rejected
      // --hermes-as-harness with --matchlock ("only supported with
      // --pi-as-harness or --dsh-as-harness"). The three-harness union admits
      // all three, so the losing rejection assertion is rewritten to accept.
      const result = parseWorkflowRunArgs(["task", "--hermes-as-harness", "--matchlock", "vic/ml"]);
      assert.equal(result.matchlockImage, "vic/ml");
      assert.equal(result.harnessAs, "hermes");
    });

    it("allows --matchlock with --pi-as-harness, --hermes-as-harness and --dsh-as-harness (MTLK-INTEGRATE US-003 acceptance)", () => {
      // MTLK-PI-EXEC union MTLK-HERMES-EXEC union MTLK-DSH-EXEC: the union
      // accepts exactly the union of the three harness opt-ins; the earlier
      // pairwise refusals (dsh in the pi+hermes slice, hermes in the pi+dsh
      // slice) are superseded by this explicit acceptance assertion.
      for (const harness of ["pi", "hermes", "dsh"] as const) {
        const result = parseWorkflowRunArgs(["task", `--${harness}-as-harness`, "--matchlock", "vic/ml"]);
        assert.equal(result.matchlockImage, "vic/ml");
        assert.equal(result.harnessAs, harness);
      }
    });

    it("allows --matchlock IMAGE with --dsh-as-harness (MTLK-DSH-EXEC US-002)", () => {
      const result = parseWorkflowRunArgs([
        "task",
        "--matchlock", "vic/ml:latest",
        "--dsh-as-harness",
      ]);
      assert.equal(result.matchlockImage, "vic/ml:latest");
      assert.equal(result.harnessAs, "dsh");
    });

    it("allows --matchlock=IMAGE with --dsh-as-harness (order independent)", () => {
      const result = parseWorkflowRunArgs([
        "--dsh-as-harness",
        "--matchlock=vic/ml:latest",
        "task",
      ]);
      assert.equal(result.matchlockImage, "vic/ml:latest");
      assert.equal(result.harnessAs, "dsh");
    });

    it("still parses --dsh-as-harness WITHOUT --matchlock (native dsh unchanged)", () => {
      const result = parseWorkflowRunArgs(["task", "--dsh-as-harness"]);
      assert.equal(result.matchlockImage, undefined);
      assert.equal(result.harnessAs, "dsh");
    });

    it("rejects --matchlock where the value is another recognized option even for dsh", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["--matchlock", "--dsh-as-harness"]),
        /is an option, not an image/,
      );
    });

    it("--matchlock after the -- separator is task text, not a flag", () => {
      const result = parseWorkflowRunArgs(["task", "--", "--matchlock", "vic/ml"]);
      assert.equal(result.matchlockImage, undefined);
      assert.equal(result.taskTitle, "task --matchlock vic/ml");
    });
  });

  // MTLK-VM-SIZE US-002: the three raw VM-size overrides.
  describe("--matchlock size flags", () => {
    const parseWithImage = (sizeArgs: string[]) =>
      parseWorkflowRunArgs(["Build feature", "--matchlock", "vic/ml", ...sizeArgs]);

    it("parses all three space forms into raw strings", () => {
      const result = parseWithImage([
        "--matchlock-cpus", "4",
        "--matchlock-memory", "4096",
        "--matchlock-disk", "40g",
      ]);
      assert.equal(result.matchlockCpus, "4");
      assert.equal(result.matchlockMemory, "4096");
      assert.equal(result.matchlockDisk, "40g");
    });

    it("parses all three --flag=value forms into raw strings", () => {
      const result = parseWithImage([
        "--matchlock-cpus=8",
        "--matchlock-memory=16g",
        "--matchlock-disk=20480",
      ]);
      assert.equal(result.matchlockCpus, "8");
      assert.equal(result.matchlockMemory, "16g");
      assert.equal(result.matchlockDisk, "20480");
    });

    it("size fields are undefined when the flags are absent", () => {
      const result = parseWorkflowRunArgs(["Build feature", "--matchlock", "vic/ml"]);
      assert.equal(result.matchlockCpus, undefined);
      assert.equal(result.matchlockMemory, undefined);
      assert.equal(result.matchlockDisk, undefined);
    });

    it("keeps raw unvalidated strings (no numeric validation in the parser)", () => {
      const result = parseWithImage(["--matchlock-cpus", "not-a-number"]);
      assert.equal(result.matchlockCpus, "not-a-number");
    });

    it("rejects a duplicate of any of the three flags", () => {
      for (const [header, value] of [
        ["--matchlock-cpus", "4"],
        ["--matchlock-memory", "4096"],
        ["--matchlock-disk", "20480"],
      ] as const) {
        assert.throws(
          () =>
            parseWorkflowRunArgs([
              "task", "--matchlock", "img",
              header, value, header, value,
            ]),
          new RegExp(`Duplicate ${header}`),
        );
      }
    });

    it("rejects a duplicate via mixed space and equals forms", () => {
      assert.throws(
        () => parseWithImage(["--matchlock-cpus", "4", "--matchlock-cpus=8"]),
        /Duplicate --matchlock-cpus/,
      );
    });

    it("rejects a missing value for any of the three flags", () => {
      for (const header of [
        "--matchlock-cpus",
        "--matchlock-memory",
        "--matchlock-disk",
      ] as const) {
        assert.throws(
          () => parseWithImage([header]),
          new RegExp(`Missing value for ${header}`),
        );
      }
    });

    it("rejects an empty value for any of the three flags", () => {
      for (const header of [
        "--matchlock-cpus",
        "--matchlock-memory",
        "--matchlock-disk",
      ] as const) {
        assert.throws(
          () => parseWorkflowRunArgs(["task", "--matchlock", "img", `${header}=`]),
          new RegExp(`Missing value for ${header}`),
        );
      }
    });

    it("never consumes another recognized option as a size value (space and equals forms)", () => {
      assert.throws(
        () => parseWithImage(["--matchlock-cpus", "--wait"]),
        /is an option, not a value/,
      );
      assert.throws(
        () => parseWorkflowRunArgs(["task", "--matchlock", "img", "--matchlock-disk=--pi-as-harness"]),
        /is an option, not a value/,
      );
    });

    it("'--matchlock --matchlock-cpus 4' does not consume the flag as the image and reports the missing-image error", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["task", "--matchlock", "--matchlock-cpus", "4"]),
        /Missing value for --matchlock/,
      );
      // The partial-run guard: the size flag is treated as an option, never
      // as the image.
      assert.throws(
        () => parseWorkflowRunArgs(["task", "--matchlock", "--matchlock-cpus=4"]),
        /Missing value for --matchlock/,
      );
    });

    it("rejects a size flag supplied without --matchlock", () => {
      for (const [header, value] of [
        ["--matchlock-cpus", "4"],
        ["--matchlock-memory", "4096"],
        ["--matchlock-disk", "20480"],
      ] as const) {
        assert.throws(
          () => parseWorkflowRunArgs(["task", header, value]),
          new RegExp(`${header} requires --matchlock <image>`),
        );
      }
    });

    it("rejects an equals-form size flag supplied without --matchlock", () => {
      assert.throws(
        () => parseWorkflowRunArgs(["task", "--matchlock-memory=4096"]),
        /--matchlock-memory requires --matchlock <image>/,
      );
    });

    it("size flags after the -- separator are task text, not flags", () => {
      const result = parseWorkflowRunArgs([
        "task", "--", "--matchlock-cpus", "4",
      ]);
      assert.equal(result.matchlockCpus, undefined);
      assert.equal(result.taskTitle, "task --matchlock-cpus 4");
    });

    it("size flags combine with a harness opt-in and --matchlock", () => {
      const result = parseWorkflowRunArgs([
        "task",
        "--dsh-as-harness",
        "--matchlock", "vic/ml",
        "--matchlock-cpus", "4",
        "--matchlock-memory=8g",
      ]);
      assert.equal(result.harnessAs, "dsh");
      assert.equal(result.matchlockImage, "vic/ml");
      assert.equal(result.matchlockCpus, "4");
      assert.equal(result.matchlockMemory, "8g");
    });
  });
});
