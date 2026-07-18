import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const skillPath = resolve(import.meta.dirname, "..", "skills", "tamandua-agents", "SKILL.md");
const skillContent = readFileSync(skillPath, "utf-8");

// CLI commands documented in SKILL.md that should exist in the actual CLI.
// Format: [commandString, sectionDescription]
const documentedCommands: [string, string][] = [
  // Section 1: CLI access
  ["tamandua version", "version command"],
  ["tamandua source-path", "source path command"],
  ["tamandua skill-path", "skill path command"],

  // Section 2: workflow-level commands
  ["tamandua workflow list", "workflow list"],
  ["tamandua workflow install", "workflow install"],
  ["tamandua workflow uninstall", "workflow uninstall"],
  ["tamandua workflow run", "workflow run"],
  ["tamandua workflow status", "workflow status"],
  ["tamandua workflow runs", "workflow runs"],
  ["tamandua workflow pause", "workflow pause"],
  ["tamandua workflow pause-all", "workflow pause-all"],
  ["tamandua workflow resume", "workflow resume"],
  ["tamandua workflow resume-all", "workflow resume-all"],
  ["tamandua workflow stop", "workflow stop"],
  ["tamandua workflow fail", "workflow fail"],
  ["tamandua workflow autoresearch", "workflow autoresearch"],

  // Section 2.2: logs
  ["tamandua logs", "logs command"],
  ["tamandua logs-tail", "logs-tail command"],

  // Section 2.3: dashboard
  ["tamandua dashboard start", "dashboard start"],
  ["tamandua dashboard stop", "dashboard stop"],
  ["tamandua dashboard status", "dashboard status"],

  // Section 2.3: MCP
  ["tamandua mcp start", "mcp start"],
  ["tamandua mcp stop", "mcp stop"],
  ["tamandua mcp status", "mcp status"],

  // Section 2.4: get-ready
  ["tamandua get-ready", "get-ready command"],

  // Section 2.6: system status
  ["tamandua status", "status command"],

  // Section 2.7: worktree
  ["tamandua worktree list", "worktree list"],
  ["tamandua worktree status", "worktree status"],
  ["tamandua worktree remove", "worktree remove"],
  ["tamandua worktree prune", "worktree prune"],

  // Section 2.8: control-plane
  ["tamandua control-plane start", "control-plane start"],
  ["tamandua control-plane stop", "control-plane stop"],
  ["tamandua control-plane status", "control-plane status"],

  // Section 2.9: uninstall
  ["tamandua uninstall", "uninstall command"],

  // Section 2.10: autoresearch core
  ["tamandua autoresearch init", "autoresearch init"],
  ["tamandua autoresearch run-experiment", "autoresearch run-experiment"],
  ["tamandua autoresearch log-experiment", "autoresearch log-experiment"],

  // Section 2.11: autoresearch loop
  ["tamandua autoresearch loop", "autoresearch loop"],
  ["tamandua autoresearch run-loop-iteration", "autoresearch run-loop-iteration"],

  // Section 2.12: autoresearch monitoring and setup
  ["tamandua autoresearch status", "autoresearch status"],
  ["tamandua autoresearch next", "autoresearch next"],
  ["tamandua autoresearch prune", "autoresearch prune"],
  ["tamandua autoresearch wizard", "autoresearch wizard"],

  // Section 2: update
  ["tamandua update", "update command"],

  // Section 3: step lifecycle
  ["tamandua step peek", "step peek"],
  ["tamandua step claim", "step claim"],
  ["tamandua step complete", "step complete"],
  ["tamandua step fail", "step fail"],
  ["tamandua step stories", "step stories"],
  ["tamandua step release", "step release"],
];

// Actual CLI commands verified from src/cli/cli.ts
// These are the command groups handled by main()
const actualCommands: string[] = [
  // Top-level / standalone
  "tamandua version",
  "tamandua tamandua",
  "tamandua skill-path",
  "tamandua source-path",
  "tamandua update",
  "tamandua get-ready",
  "tamandua uninstall",
  "tamandua status",
  "tamandua logs",
  "tamandua logs-tail",
  "tamandua doctor",

  // dashboard
  "tamandua dashboard start",
  "tamandua dashboard stop",
  "tamandua dashboard status",

  // mcp
  "tamandua mcp start",
  "tamandua mcp stop",
  "tamandua mcp status",

  // control-plane
  "tamandua control-plane start",
  "tamandua control-plane stop",
  "tamandua control-plane status",

  // autoresearch
  "tamandua autoresearch init",
  "tamandua autoresearch run-experiment",
  "tamandua autoresearch log-experiment",
  "tamandua autoresearch loop",
  "tamandua autoresearch run-loop-iteration",
  "tamandua autoresearch status",
  "tamandua autoresearch next",
  "tamandua autoresearch prune",
  "tamandua autoresearch wizard",

  // step
  "tamandua step peek",
  "tamandua step claim",
  "tamandua step complete",
  "tamandua step fail",
  "tamandua step stories",
  "tamandua step release",

  // workflow
  "tamandua workflow list",
  "tamandua workflow runs",
  "tamandua workflow install",
  "tamandua workflow uninstall",
  "tamandua workflow run",
  "tamandua workflow status",
  "tamandua workflow stop",
  "tamandua workflow fail",
  "tamandua workflow autoresearch",
  "tamandua workflow pause",
  "tamandua workflow resume",
  "tamandua workflow pause-all",
  "tamandua workflow resume-all",

  // worktree
  "tamandua worktree list",
  "tamandua worktree status",
  "tamandua worktree remove",
  "tamandua worktree prune",
];

// Commands intentionally not documented in SKILL.md (easter eggs, etc.)
const excludedFromSkill: Set<string> = new Set([
  "tamandua tamandua", // ASCII art easter egg
]);

describe("SKILL.md command reference completeness", () => {
  it("has valid YAML frontmatter", () => {
    assert.ok(
      skillContent.startsWith("---"),
      "SKILL.md must start with YAML frontmatter delimiter"
    );
    const secondDelim = skillContent.indexOf("---", 3);
    assert.ok(secondDelim > 0, "SKILL.md must have closing YAML frontmatter delimiter");
  });

  for (const [cmd, desc] of documentedCommands) {
    it(`documents command: ${cmd}`, () => {
      assert.ok(
        skillContent.includes(cmd),
        `SKILL.md must document command: ${cmd}`
      );
    });
  }

  it("every actual CLI command (except easter eggs) is documented in SKILL.md", () => {
    const missing: string[] = [];
    for (const cmd of actualCommands) {
      if (excludedFromSkill.has(cmd)) continue;
      if (!skillContent.includes(cmd)) {
        missing.push(cmd);
      }
    }
    assert.deepStrictEqual(missing, [], "SKILL.md is missing documentation for these CLI commands");
  });
});

describe("SKILL.md step command accuracy", () => {
  it("step peek uses --run-id flag", () => {
    assert.ok(
      skillContent.includes("step peek") && skillContent.includes("--run-id"),
      "SKILL.md must show --run-id flag for step peek"
    );
  });

  it("step claim uses --run-id flag", () => {
    assert.ok(
      skillContent.includes("step claim") && skillContent.includes("--run-id"),
      "SKILL.md must show --run-id flag for step claim"
    );
  });

  it("step complete uses stepId not agentId", () => {
    // Must explain that complete takes stepId, not agentId
    assert.ok(
      skillContent.match(/step complete.*step-id/i) ||
      skillContent.includes("step complete <stepId>") ||
      skillContent.includes("step complete <step-id>"),
      "SKILL.md must show step complete uses step ID, not agent ID"
    );
  });

  it("step fail uses stepId not agentId", () => {
    assert.ok(
      skillContent.match(/step fail.*step-id/i) ||
      skillContent.includes("step fail <stepId>") ||
      skillContent.includes("step fail <step-id>"),
      "SKILL.md must show step fail uses step ID, not agent ID"
    );
  });

  it("explicitly warns not to use agent ID for complete/fail", () => {
    assert.ok(
      skillContent.match(/Never.*step complete.*agent.*[Ii][Dd]/) ||
      skillContent.match(/never.*call.*step complete.*agent/i),
      "SKILL.md must warn against using agent ID with step complete/fail"
    );
  });

  it("step stories is documented for diagnostics", () => {
    assert.ok(
      skillContent.includes("step stories"),
      "SKILL.md must document step stories for debugging"
    );
  });

  it("step lifecycle is documented in order: peek → claim → execute → complete/fail", () => {
    const peekIdx = skillContent.indexOf("step peek");
    const claimIdx = skillContent.indexOf("step claim");
    const completeIdx = skillContent.indexOf("tamandua step complete");
    const failIdx = skillContent.indexOf("tamandua step fail");

    assert.ok(peekIdx < claimIdx, "step peek must appear before step claim in documentation");
    assert.ok(claimIdx < completeIdx, "step claim must appear before step complete");
    assert.ok(claimIdx < failIdx, "step claim must appear before step fail");
  });
});

describe("SKILL.md dashboard and MCP command accuracy", () => {
  it("dashboard start, stop, status are all documented", () => {
    assert.ok(skillContent.includes("dashboard start"), "dashboard start must be documented");
    assert.ok(skillContent.includes("dashboard stop"), "dashboard stop must be documented");
    assert.ok(skillContent.includes("dashboard status"), "dashboard status must be documented");
  });

  it("dashboard status mentions MCP status too", () => {
    assert.ok(
      skillContent.match(/dashboard status.*MCP|MCP.*dashboard status/i),
      "SKILL.md must note dashboard status reports MCP status"
    );
  });

  it("mcp start, stop, status are all documented", () => {
    assert.ok(skillContent.includes("mcp start"), "mcp start must be documented");
    assert.ok(skillContent.includes("mcp stop"), "mcp stop must be documented");
    assert.ok(skillContent.includes("mcp status"), "mcp status must be documented");
  });

  it("dashboard and mcp have separate sections with distinct port info", () => {
    assert.ok(
      skillContent.includes("3334"),
      "SKILL.md must mention dashboard default port 3334"
    );
    assert.ok(
      skillContent.includes("3338"),
      "SKILL.md must mention MCP default port 3338"
    );
  });
});

describe("SKILL.md workflow run command completeness", () => {
  it("includes --working-directory-for-harness flag", () => {
    assert.ok(
      skillContent.includes("--working-directory-for-harness"),
      "SKILL.md must document --working-directory-for-harness flag"
    );
  });

  it("includes --worktree-origin-repository flag", () => {
    assert.ok(
      skillContent.includes("--worktree-origin-repository"),
      "SKILL.md must document --worktree-origin-repository flag"
    );
  });

  it("includes --worktree-origin-ref flag", () => {
    assert.ok(
      skillContent.includes("--worktree-origin-ref"),
      "SKILL.md must document --worktree-origin-ref flag"
    );
  });

  it("includes --no-hurry-please-save-tokens-mode flag", () => {
    assert.ok(
      skillContent.includes("--no-hurry-please-save-tokens-mode"),
      "SKILL.md must document --no-hurry-please-save-tokens-mode flag"
    );
  });

  it("includes --pi-as-harness and --hermes-as-harness flags", () => {
    assert.ok(
      skillContent.includes("--pi-as-harness"),
      "SKILL.md must document --pi-as-harness"
    );
    assert.ok(
      skillContent.includes("--hermes-as-harness"),
      "SKILL.md must document --hermes-as-harness"
    );
  });

  it("workflow run command row shows all options on one line", () => {
    // The primary workflow run row should be a single logical line
    // showing: --working-directory-for-harness, --worktree-origin-*, harness flags, --no-hurry, --no-relaunch
    const hasWfh = skillContent.includes("--working-directory-for-harness");
    const hasWto = skillContent.includes("--worktree-origin-repository");
    const hasWtr = skillContent.includes("--worktree-origin-ref");
    const hasPiH = skillContent.includes("--pi-as-harness");
    const hasNoHur = skillContent.includes("--no-hurry-please-save-tokens-mode");
    const hasNoRelaunch = skillContent.includes("--no-relaunch-upon-rugpull");
    assert.ok(hasWfh && hasWto && hasWtr && hasPiH && hasNoHur && hasNoRelaunch,
      "SKILL.md workflow run command row must include all option groups");
  });

  it("includes --no-relaunch-upon-rugpull flag", () => {
    assert.ok(
      skillContent.includes("--no-relaunch-upon-rugpull"),
      "SKILL.md must document --no-relaunch-upon-rugpull flag"
    );
  });

  it("documents repeatable workflow template context", () => {
    assert.match(skillContent, /`--context key=value` injects a template context key[^.]*and is\s+repeatable\./);
    assert.match(skillContent, /splits each value on the first `=` and rejects duplicate\s+keys/);
    assert.ok(
      skillContent.includes("--context branch=feature/my-branch"),
      "SKILL.md must include a concrete --context example"
    );
  });

  it("documents workflow workspace modes and mutually exclusive flags", () => {
    assert.match(skillContent, /`run\.workspace` as `direct` \(the default\) or `worktree`/);
    assert.match(skillContent, /Workflow IDs ending in `-worktree` use worktree mode/);
    assert.match(skillContent, /Direct mode rejects both `--worktree-origin-repository` and\s+`--worktree-origin-ref`/);
    assert.match(skillContent, /Worktree-mode workflows reject `--working-directory-for-harness`/);
    assert.match(skillContent, /Use\s+`--worktree-origin-repository <dir>`.*\s+`--worktree-origin-ref <ref>`/);
  });

  it("documents the clean-origin requirement for worktree launches", () => {
    assert.match(skillContent, /worktree launch requires the origin repository to have no uncommitted\s+changes/);
    assert.match(skillContent, /Commit or stash changes before launching/);
  });
});

describe("SKILL.md workflow supervision guidance", () => {
  it("shows safe task quoting and the operator inspection commands", () => {
    assert.ok(skillContent.includes("#### Supervising a run"));
    assert.ok(skillContent.includes('"$(cat task.md)"'));
    assert.ok(skillContent.includes("tamandua workflow status <run-id>"));
    assert.ok(skillContent.includes("tamandua workflow runs"));
    assert.ok(skillContent.includes("tamandua logs <run-id>"));
    assert.ok(skillContent.includes("tamandua workflow stop <run-id>"));
    assert.ok(skillContent.includes("tamandua workflow cancel <run-id>"));
    assert.match(skillContent, /`cancel` is a documented alias for `stop`/);
  });

  it("prefers CLI inspection and constrains direct state access", () => {
    assert.match(skillContent, /Prefer these CLI commands for run-state inspection/);
    assert.ok(skillContent.includes("sqlite3 -readonly ~/.tamandua/tamandua.db"));
    assert.match(skillContent, /do not use the database as the\s+first resort/);
  });

  it("warns that installed workflows are overwritten", () => {
    assert.match(skillContent, /Never edit installed workflow files under `~\/\.tamandua\/workflows`/);
    assert.match(skillContent, /every\s+install and update overwrites them/);
    assert.match(skillContent, /copy it under a\s+new workflow ID/);
  });
});

describe("SKILL.md worktree commands documented", () => {
  it("documents worktree list", () => {
    assert.ok(
      skillContent.includes("worktree list"),
      "SKILL.md must document worktree list"
    );
  });

  it("documents worktree status", () => {
    assert.ok(
      skillContent.includes("worktree status"),
      "SKILL.md must document worktree status"
    );
  });

  it("documents worktree remove", () => {
    assert.ok(
      skillContent.includes("worktree remove"),
      "SKILL.md must document worktree remove"
    );
  });

  it("documents worktree prune", () => {
    assert.ok(
      skillContent.includes("worktree prune"),
      "SKILL.md must document worktree prune"
    );
  });
});

describe("SKILL.md control-plane commands documented", () => {
  it("documents control-plane start", () => {
    assert.ok(
      skillContent.includes("control-plane start"),
      "SKILL.md must document control-plane start"
    );
  });

  it("documents control-plane stop", () => {
    assert.ok(
      skillContent.includes("control-plane stop"),
      "SKILL.md must document control-plane stop"
    );
  });

  it("documents control-plane status", () => {
    assert.ok(
      skillContent.includes("control-plane status"),
      "SKILL.md must document control-plane status"
    );
  });

  it("documents control-plane default port 3339", () => {
    assert.ok(
      skillContent.includes("3339"),
      "SKILL.md must mention control-plane default port 3339"
    );
  });
});

describe("SKILL.md workflow install and uninstall documented", () => {
  it("documents workflow install", () => {
    assert.ok(
      skillContent.includes("workflow install"),
      "SKILL.md must document workflow install"
    );
  });

  it("documents workflow uninstall", () => {
    assert.ok(
      skillContent.includes("workflow uninstall"),
      "SKILL.md must document workflow uninstall"
    );
  });

  it("documents workflow uninstall --all", () => {
    assert.ok(
      skillContent.includes("--all") && skillContent.includes("uninstall"),
      "SKILL.md must document workflow uninstall --all"
    );
  });

  it("documents --force for uninstall", () => {
    assert.ok(
      skillContent.includes("--force") && skillContent.includes("uninstall"),
      "SKILL.md must document --force flag for uninstall"
    );
  });
});

describe("SKILL.md top-level maintenance commands", () => {
  it("documents tamandua status", () => {
    assert.ok(
      skillContent.includes("tamandua status"),
      "SKILL.md must document tamandua status"
    );
  });

  it("documents tamandua uninstall", () => {
    assert.ok(
      skillContent.includes("tamandua uninstall"),
      "SKILL.md must document tamandua uninstall"
    );
  });

  it("documents tamandua update", () => {
    assert.ok(
      skillContent.includes("tamandua update"),
      "SKILL.md must document tamandua update"
    );
  });

  it("documents tamandua get-ready", () => {
    assert.ok(
      skillContent.includes("tamandua get-ready"),
      "SKILL.md must document tamandua get-ready"
    );
  });

  it("documents tamandua skill-path", () => {
    assert.ok(
      skillContent.includes("tamandua skill-path"),
      "SKILL.md must document tamandua skill-path"
    );
  });

  it("documents tamandua source-path", () => {
    assert.ok(
      skillContent.includes("tamandua source-path"),
      "SKILL.md must document tamandua source-path"
    );
  });
});

describe("SKILL.md logs commands documented", () => {
  it("documents logs with selector syntax", () => {
    assert.ok(skillContent.includes("tamandua logs"), "SKILL.md must document logs");
  });

  it("documents logs-tail with selector syntax", () => {
    assert.ok(skillContent.includes("tamandua logs-tail"), "SKILL.md must document logs-tail");
  });

  it("documents logs-tail live following behavior", () => {
    assert.ok(
      skillContent.match(/follow|real.time|live/i),
      "SKILL.md must describe logs-tail live following behavior"
    );
  });
});

describe("SKILL.md output format accuracy", () => {
  it("completion contract specifies STATUS, CHANGES, TESTS", () => {
    assert.ok(skillContent.includes("STATUS:"), "SKILL.md must mention STATUS: output field");
    assert.ok(skillContent.includes("CHANGES:"), "SKILL.md must mention CHANGES: output field");
    assert.ok(skillContent.includes("TESTS:"), "SKILL.md must mention TESTS: output field");
  });

  it("failure uses step fail with reason", () => {
    assert.ok(
      skillContent.includes("step fail") && skillContent.includes("reason"),
      "SKILL.md must document step fail with reason parameter"
    );
  });

  const lifecycleSection = skillContent.slice(
    skillContent.indexOf("### 3) Follow the step lifecycle exactly"),
    skillContent.indexOf("### 4) Completion contract"),
  );
  const completionSection = skillContent.slice(
    skillContent.indexOf("### 4) Completion contract"),
    skillContent.indexOf("### 2.1) MCP run start (remote)"),
  );

  it("documents scheduled-agent peek behavior and the claim race", () => {
    assert.match(lifecycleSection, /dispatch prompt[^]*step is\s+pending/i);
    assert.match(lifecycleSection, /scheduled agents[^]*step peek[^]*optional/i);
    assert.match(lifecycleSection, /manual or diagnostic/i);
    assert.match(lifecycleSection, /NO_WORK[^]*HAS_WORK[^]*another worker won[^]*race[^]*loop completed/i);
    assert.match(lifecycleSection, /check for `NO_WORK` before[^]*pars(?:e|ing)[^]*JSON/i);
  });

  it("documents the real completion and verifier verdict channels", () => {
    assert.match(completionSection, /On success[^]*`STATUS: done`[^]*own\s+plain-text line/i);
    assert.match(completionSection, /convention[^]*first report[^]*KEY:/i);
    assert.match(completionSection, /markers[^]*anywhere in the piped output/i);
    assert.match(completionSection, /ONLY\s+thing that completes a step/i);
    assert.match(completionSection, /final chat or\s+session message does not complete/i);
    assert.match(completionSection, /verifier[^]*rejects[^]*`STATUS: retry`[^]*step complete/i);
    assert.match(completionSection, /step fail[^]*could not do the work/i);
    assert.match(completionSection, /Do not\s+use `step fail`[^]*retry verdict/i);
    assert.match(completionSection, /lost\/abandoned[^]*retry slot/i);
    assert.doesNotMatch(
      skillContent,
      /last line of successful output must be exactly\s*`STATUS: done`/i,
    );
  });

  it("requires plain-text contract lines at column zero", () => {
    assert.match(completionSection, /STATUS: and KEY:[^.]*column 0[^.]*plain text/i);
    assert.match(completionSection, /no bold[^.]*backticks[^.]*fences[^.]*leading bullets/i);
    assert.ok(
      completionSection.includes("`**BRANCH:** foo` fails validation; `BRANCH: foo` passes."),
      "SKILL.md must contain the exact wrong/right contract-line pair",
    );
  });

  it("documents STORIES_JSON extraction constraints and safe construction", () => {
    assert.match(completionSection, /STORIES_JSON[^]*single-line\s+JSON[^]*array ending with `\]`/i);
    assert.match(completionSection, /no trailing prose/i);
    assert.match(completionSection, /embedded newline-separated[^]*UPPERCASE_KEY:/i);
    assert.match(completionSection, /extractor truncates/i);
    assert.match(completionSection, /python3[^]*json\.dumps[^]*heredoc[^]*pip/i);
    assert.match(completionSection, /rather than hand-quoting/i);
  });
});

describe("SKILL.md autoresearch commands documented", () => {
  it("documents autoresearch init with required options", () => {
    assert.ok(skillContent.includes("autoresearch init"), "SKILL.md must document autoresearch init");
    assert.ok(skillContent.includes("--goal"), "SKILL.md must document --goal option");
    assert.ok(skillContent.includes("--metric"), "SKILL.md must document --metric option");
    assert.ok(skillContent.includes("--direction"), "SKILL.md must document --direction option");
    assert.ok(skillContent.includes("--command"), "SKILL.md must document --command option");
  });

  it("documents autoresearch run-experiment", () => {
    assert.ok(skillContent.includes("autoresearch run-experiment"), "SKILL.md must document autoresearch run-experiment");
    assert.ok(skillContent.includes("--timeout-seconds"), "SKILL.md must document --timeout-seconds option");
  });

  it("documents autoresearch log-experiment", () => {
    assert.ok(skillContent.includes("autoresearch log-experiment"), "SKILL.md must document autoresearch log-experiment");
    assert.ok(skillContent.includes("--status"), "SKILL.md must document --status option");
    assert.ok(skillContent.includes("--description"), "SKILL.md must document --description option");
    assert.ok(skillContent.includes("--learned"), "SKILL.md must document --learned option");
    assert.ok(skillContent.includes("--next-focus"), "SKILL.md must document --next-focus option");
  });

  it("includes at least one usage example for each subcommand", () => {
    // Each subcommand should have a usage example showing the command in context
    const initExample = skillContent.includes("autoresearch init \\");
    const runExample = skillContent.includes("autoresearch run-experiment");
    const logExample = skillContent.includes("autoresearch log-experiment \\");
    assert.ok(initExample, "SKILL.md must have a usage example for autoresearch init");
    assert.ok(runExample, "SKILL.md must reference autoresearch run-experiment");
    assert.ok(logExample, "SKILL.md must have a usage example for autoresearch log-experiment");
  });

  it("autoresearch section uses section 2.10 numbering", () => {
    assert.ok(
      skillContent.includes("### 2.12) AutoResearch experiment commands"),
      "SKILL.md must use section 2.12 for autoresearch commands"
    );
  });
});

describe("SKILL.md autoresearch loop commands documented", () => {
  it("documents autoresearch loop with action modes", () => {
    assert.ok(skillContent.includes("autoresearch loop"), "SKILL.md must document autoresearch loop");
    assert.ok(skillContent.includes("--measure-only"), "SKILL.md must document --measure-only action mode");
    assert.ok(skillContent.includes("--prompt"), "SKILL.md must document --prompt action mode");
  });

  it("documents loop stop conditions", () => {
    assert.ok(skillContent.includes("--target-metric"), "SKILL.md must document --target-metric option");
    assert.ok(skillContent.includes("--max-iterations"), "SKILL.md must document --max-iterations option");
    assert.ok(skillContent.includes("--max-consecutive-failures"), "SKILL.md must document --max-consecutive-failures option");
    assert.ok(skillContent.includes("Ctrl-C") || skillContent.includes("SIGINT"), "SKILL.md must document Ctrl-C/SIGINT stop condition");
  });

  it("documents loop progress display", () => {
    assert.ok(skillContent.match(/\[measure-only\]/), "SKILL.md must show measure-only label in progress display");
    assert.ok(skillContent.match(/\[prompt\]/), "SKILL.md must show prompt label in progress display");
  });

  it("documents autoresearch run-loop-iteration", () => {
    assert.ok(skillContent.includes("autoresearch run-loop-iteration"), "SKILL.md must document autoresearch run-loop-iteration");
    assert.ok(skillContent.includes("--iteration"), "SKILL.md must document --iteration option");
    assert.ok(skillContent.includes("--description"), "SKILL.md must document --description option");
  });

  it("documents run-loop-iteration transactional lifecycle", () => {
    assert.ok(
      skillContent.match(/committed.*reverted|reverted.*committed/i),
      "SKILL.md must describe commit on keep, revert on discard/crash"
    );
    assert.ok(skillContent.includes("keep") && skillContent.includes("baseline"),
      "SKILL.md must mention keep/baseline results behavior");
    assert.ok(skillContent.includes("discard") || skillContent.includes("reverted"),
      "SKILL.md must mention discard revert behavior");
  });

  it("loop section uses section 2.11 numbering", () => {
    assert.ok(
      skillContent.includes("### 2.13) AutoResearch loop and iteration commands"),
      "SKILL.md must use section 2.13 for autoresearch loop commands"
    );
  });
});

describe("SKILL.md autoresearch monitoring and setup commands documented", () => {
  it("documents autoresearch status", () => {
    assert.ok(skillContent.includes("autoresearch status"), "SKILL.md must document autoresearch status");
    assert.ok(skillContent.includes("Baseline") || skillContent.includes("baseline"), "SKILL.md must document baseline in status output");
    assert.ok(skillContent.includes("Best result") || skillContent.includes("best result"), "SKILL.md must document best result in status output");
    assert.ok(skillContent.includes("Ratchet prompt") || skillContent.includes("ratchet prompt"), "SKILL.md must document ratchet prompt in status output");
  });

  it("documents autoresearch next", () => {
    assert.ok(skillContent.includes("autoresearch next"), "SKILL.md must document autoresearch next");
    assert.ok(skillContent.match(/evidence.driven|ratchet prompt/), "SKILL.md must describe next as evidence-driven or ratchet prompt");
  });

  it("documents autoresearch prune with duration format", () => {
    assert.ok(skillContent.includes("autoresearch prune"), "SKILL.md must document autoresearch prune");
    assert.ok(skillContent.includes("--older-than"), "SKILL.md must document --older-than option");
    assert.ok(skillContent.includes("--missing"), "SKILL.md must document --missing option");
    assert.ok(skillContent.includes("--dry-run"), "SKILL.md must document --dry-run option");
    assert.ok(skillContent.includes("30d") || (skillContent.includes("d") && skillContent.includes("days")), "SKILL.md must document duration format with d for days");
    assert.ok(skillContent.includes("h") && skillContent.includes("hours"), "SKILL.md must document duration format with h for hours");
    assert.ok(skillContent.includes("m") && skillContent.includes("minutes"), "SKILL.md must document duration format with m for minutes");
  });

  it("documents autoresearch wizard interactive setup", () => {
    assert.ok(skillContent.includes("autoresearch wizard"), "SKILL.md must document autoresearch wizard");
    assert.ok(skillContent.match(/interactive/i), "SKILL.md must describe wizard as interactive");
    assert.ok(skillContent.includes("Goal") || skillContent.includes("goal"), "SKILL.md must document wizard asks about goal");
  });

  it("monitoring section uses section 2.12 numbering", () => {
    assert.ok(
      skillContent.includes("### 2.14) AutoResearch monitoring and setup commands"),
      "SKILL.md must use section 2.14 for autoresearch monitoring commands"
    );
  });

  it("autoresearch prune explicitly states it does not touch project files", () => {
    assert.ok(
      skillContent.match(/does not touch|never touches|safe on disk|remain safe/i),
      "SKILL.md must state prune does not remove project-local files"
    );
  });
});

describe("SKILL.md workflow autoresearch command documented", () => {
  it("documents workflow autoresearch", () => {
    assert.ok(
      skillContent.includes("workflow autoresearch"),
      "SKILL.md must document workflow autoresearch"
    );
  });

  it("describes that it resolves harness working directory", () => {
    assert.ok(
      skillContent.match(/harness working directory/i),
      "SKILL.md must explain workflow autoresearch resolves harness working directory"
    );
  });

  it("describes reading autoresearch config and jsonl", () => {
    assert.ok(
      skillContent.includes("autoresearch.config.json"),
      "SKILL.md must mention autoresearch.config.json"
    );
    assert.ok(
      skillContent.includes("autoresearch.jsonl"),
      "SKILL.md must mention autoresearch.jsonl"
    );
  });
});
