// catalog.mjs — pinned bundled-catalog installation for the aged-state seed.
//
// The seed's private state must contain the exact PINNED bundled workflow
// catalog (identical workflow.yml + definition files) because runs are created
// through the REAL runWorkflow, which loads each workflow spec from
// <state>/workflows/<id>.  We install the catalog with the REAL tamandua
// CLI (`tamandua workflow install --all`) pointed at the private HOME/state and
// at TAMANDUA_WORKFLOWS_SRC (the repo's bundled workflows dir at the pinned
// HEAD).  No real provider configuration is copied; install under a private
// HOME only touches the private state.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { gitExec } from "./seedcommon.mjs";
import { pinCatalog, verifyCatalogStateDir } from "./manifest.mjs";

export function repoWorkflowsSource(repoRoot) {
  return path.join(repoRoot, "workflows");
}

export function listBundledIds(sourceDir) {
  const ids = [];
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const yml = path.join(sourceDir, entry.name, "workflow.yml");
    if (!fs.existsSync(yml)) continue;
    // Confirm the yml's declared id matches the directory name (catalog shape).
    const raw = fs.readFileSync(yml, "utf-8");
    const m = /^id:\s*(\S+)/m.exec(raw);
    const declared = m ? m[1] : null;
    if (declared !== entry.name) {
      throw new Error(
        `catalog shape mismatch: dir ${entry.name} declares id ${declared}`,
      );
    }
    ids.push(entry.name);
  }
  return ids.sort();
}

// Install the whole pinned catalog into a private state dir via the real CLI.
// Returns the CLI's exit code + output.  Requires env to be a containment env
// (private HOME/state) and tamanduaCli to be the LIVE step CLI.
export function installCatalogViaRealCli({ tamanduaCli, env, repoRoot }) {
  const sourceDir = repoWorkflowsSource(repoRoot);
  const ids = listBundledIds(sourceDir);
  const pinned = pinCatalog(sourceDir, ids);

  const runEnv = {
    ...env,
    TAMANDUA_WORKFLOWS_SRC: sourceDir,
  };

  const res = spawnSync(tamanduaCli, ["workflow", "install", "--all"], {
    env: runEnv,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (res.status !== 0) {
    throw new Error(
      `tamandua workflow install --all failed (exit ${res.status}): ${(res.stderr || res.stdout || "").slice(-2000)}`,
    );
  }

  const stateWorkflows = path.join(env.TAMANDUA_STATE_DIR, "workflows");
  const verify = verifyCatalogStateDir(stateWorkflows, pinned);
  const bad = Object.entries(verify).filter(([, v]) => !v.ok);
  if (bad.length > 0) {
    throw new Error(
      `installed catalog verification failed for ${bad.length} workflow(s): ${bad
        .map(([id, v]) => `${id}:${v.reason ?? "hash mismatch"}`)
        .join(", ")}`,
    );
  }
  return { ids, pinned, verify, stateWorkflows };
}
