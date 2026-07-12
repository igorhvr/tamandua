import fs from "node:fs";
import path from "node:path";

import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  resolveRunRoot,
  resolveTamanduaRoot,
  resolveWorkflowRoot,
  resolveWorkflowDir,
  resolveWorkflowWorkspaceRoot,
  resolveWorkflowWorkspaceDir,
} from "../../dist/installer/paths.js";

const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const testStateDir = tamanduaTempDir("tamandua-paths-");
process.env.TAMANDUA_STATE_DIR = testStateDir;

after(() => {
  if (originalStateDir === undefined) {
    delete process.env.TAMANDUA_STATE_DIR;
  } else {
    process.env.TAMANDUA_STATE_DIR = originalStateDir;
  }
  fs.rmSync(testStateDir, { recursive: true, force: true });
});

describe("paths resolveRunRoot", () => {
  it("returns runs dir under state dir", () => {
    const dir = resolveRunRoot();
    assert.equal(dir, path.join(testStateDir, "runs"));
  });
});

describe("paths resolveTamanduaRoot", () => {
  it("returns the state dir", () => {
    const dir = resolveTamanduaRoot();
    assert.equal(dir, testStateDir);
  });
});

describe("paths resolveWorkflowRoot", () => {
  it("returns workflows dir under state dir", () => {
    const dir = resolveWorkflowRoot();
    assert.equal(dir, path.join(testStateDir, "workflows"));
  });
});

describe("paths resolveWorkflowDir", () => {
  it("returns workflow-specific dir under workflows root", () => {
    const dir = resolveWorkflowDir("my-wf");
    assert.equal(dir, path.join(testStateDir, "workflows", "my-wf"));
  });
});

describe("paths resolveWorkflowWorkspaceRoot", () => {
  it("returns workspaces/workflows dir under state dir", () => {
    const dir = resolveWorkflowWorkspaceRoot();
    assert.equal(dir, path.join(testStateDir, "workspaces", "workflows"));
  });
});

describe("paths resolveWorkflowWorkspaceDir", () => {
  it("returns workflow-specific workspace dir", () => {
    const dir = resolveWorkflowWorkspaceDir("my-wf");
    assert.equal(dir, path.join(testStateDir, "workspaces", "workflows", "my-wf"));
  });
});
