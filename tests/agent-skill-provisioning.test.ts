import { createTempHome } from "./helpers/test-env.ts";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { provisionAgents } from "../dist/installer/agent-provision.js";

function writeText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

function withStateDir<T>(stateDir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.TAMANDUA_STATE_DIR;
  process.env.TAMANDUA_STATE_DIR = stateDir;
  return run().finally(() => {
    if (previous === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = previous;
  });
}

describe("agent skill provisioning", () => {
  it("copies workflow-local agent skills into the provisioned agent directory", async () => {
    const root = createTempHome("tamandua-local-skill-").root;
    const stateDir = path.join(root, "state");
    const workflowDir = path.join(root, "workflow");

      writeText(
        path.join(workflowDir, "agents", "developer", "skills", "local-helper", "SKILL.md"),
        "# local skill\n",
      );
      writeText(
        path.join(workflowDir, "agents", "developer", "skills", "local-helper", "examples", "example.md"),
        "example",
      );

      const workflow = {
        id: "workflow-local",
        agents: [
          {
            id: "developer",
            workspace: {
              baseDir: "agents/developer",
              files: {},
              skills: ["local-helper"],
            },
          },
        ],
        steps: [],
      };

      await withStateDir(stateDir, async () => {
        await provisionAgents({
          workflow,
          workflowDir,
        });
      });

      const copiedSkillDir = path.join(
        stateDir,
        "agents",
        "workflow-local_developer",
        "skills",
        "local-helper",
      );
      assert.equal(fs.existsSync(path.join(copiedSkillDir, "SKILL.md")), true);
      assert.equal(
        fs.readFileSync(path.join(copiedSkillDir, "examples", "example.md"), "utf-8"),
        "example",
      );
  });

  it("copies shared bundled skills from repository-level skills directories", async () => {
    const root = createTempHome("tamandua-shared-skill-").root;
    const stateDir = path.join(root, "state");
    const workflowDir = path.join(root, "installed", "workflows", "workflow-shared");
    const bundledSourceDir = path.join(root, "bundled", "workflows", "workflow-shared");

      writeText(path.join(workflowDir, "agents", "developer", ".keep"), "");
      writeText(path.join(bundledSourceDir, "agents", "developer", ".keep"), "");
      writeText(
        path.join(root, "bundled", "skills", "tamandua-agents", "SKILL.md"),
        "# bundled shared skill\n",
      );
      writeText(
        path.join(root, "bundled", "skills", "tamandua-agents", "examples", "usage.md"),
        "shared usage",
      );

      const workflow = {
        id: "workflow-shared",
        agents: [
          {
            id: "developer",
            workspace: {
              baseDir: "agents/developer",
              files: {},
              skills: ["tamandua-agents"],
            },
          },
        ],
        steps: [],
      };

      await withStateDir(stateDir, async () => {
        await provisionAgents({
          workflow,
          workflowDir,
          bundledSourceDir,
        });
      });

      const copiedSkillDir = path.join(
        stateDir,
        "agents",
        "workflow-shared_developer",
        "skills",
        "tamandua-agents",
      );
      assert.equal(fs.existsSync(path.join(copiedSkillDir, "SKILL.md")), true);
      assert.equal(
        fs.readFileSync(path.join(copiedSkillDir, "examples", "usage.md"), "utf-8"),
        "shared usage",
      );
  });
});
