/**
 * Atomic plumbing merge command.
 *
 * Extracted mechanically from src/cli/cli.ts (SPL2 story US-013).
 */

import { runPlumbingMerge } from "../../installer/merge-branch.js";

const MERGE_BRANCH_OPTIONS = ["--origin", "--branch", "--into", "--expect-tip", "--message"] as const;
export type MergeBranchOption = typeof MERGE_BRANCH_OPTIONS[number];

export function parseMergeBranchOptions(args: string[]): Record<MergeBranchOption, string> {
  const allowed = new Set<string>(MERGE_BRANCH_OPTIONS);
  const parsed = new Map<MergeBranchOption, string>();

  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument ${token}. All merge-branch inputs must use named options.`);
    }

    const equalsIndex = token.indexOf("=");
    const name = (equalsIndex === -1 ? token : token.slice(0, equalsIndex)) as MergeBranchOption;
    if (!allowed.has(name)) throw new Error(`Unknown option ${name}.`);
    if (parsed.has(name)) throw new Error(`Duplicate option ${name}.`);

    let value: string | undefined;
    if (equalsIndex !== -1) {
      value = token.slice(equalsIndex + 1);
    } else {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index++;
      }
    }
    if (!value?.trim()) throw new Error(`Missing value for ${name}.`);
    parsed.set(name, value);
  }

  for (const name of MERGE_BRANCH_OPTIONS) {
    if (!parsed.has(name)) throw new Error(`Missing required option ${name}.`);
  }

  return Object.fromEntries(parsed) as Record<MergeBranchOption, string>;
}

export function getMergeBranchHelp(): string {
  return `tamandua merge-branch — Atomically land a squash merge with Git plumbing

Usage: tamandua merge-branch --origin <repo-path> --branch <feature-branch> --into <target-ref> --expect-tip <sha> --message <commit-message>

All options are required and must be specified exactly once:
  --origin <repo-path>       Origin Git repository whose target ref is updated
  --branch <feature-branch>  Feature branch to squash
  --into <target-ref>        Explicit target branch name (never defaults to main)
  --expect-tip <sha>         Required current target commit for atomic compare-and-swap
  --message <message>        Commit message for the squash commit

Machine-readable results:
  STATUS: landed
  NOOP: <true | false>
  MERGED_COMMIT: <sha>
  MERGED_TREE: <tree-sha>
  TARGET: refs/heads/<target-ref>
  CHECKOUT_REFRESH: <refreshed | skipped:<reason> | not-applicable>

Landing outcomes:
  true               Feature content was already landed; target tip/tree are unchanged
  false              A new squash commit was created and landed

Checkout refresh outcomes:
  refreshed          Checked-out target index and worktree were synchronized
  skipped:<reason>   Refresh was safely skipped; the merge still landed
  not-applicable     Origin is bare or the target branch is not checked out

  STATUS: target_moved

  STATUS: conflicts
  <Git conflict listing>

Exit codes:
  0  Newly landed or already landed (no-op)
  1  Invalid invocation or operational Git error
  2  Target moved before atomic landing
  3  Merge conflicts`;
}

/**
 * Handle the merge-branch command.
 * Returns true if the command was handled, false if it belongs to another group.
 */
export function handleMergeBranch(group: string, args: string[]): boolean {
  if (group !== "merge-branch") return false;

  let options: Record<MergeBranchOption, string>;
  try {
    options = parseMergeBranchOptions(args.slice(1));
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\nRun tamandua merge-branch --help for usage.\n`);
    process.exitCode = 1;
    return true;
  }

  const result = runPlumbingMerge({
    origin: options["--origin"],
    branch: options["--branch"],
    into: options["--into"],
    expectTip: options["--expect-tip"],
    message: options["--message"],
  });
  if (result.status === "landed") {
    process.stdout.write(`STATUS: landed\nNOOP: ${result.noop}\nMERGED_COMMIT: ${result.mergedCommit}\nMERGED_TREE: ${result.mergedTree}\nTARGET: ${result.target}\nCHECKOUT_REFRESH: ${result.checkoutRefresh}\n`);
  } else if (result.status === "target_moved") {
    process.stdout.write("STATUS: target_moved\n");
    process.stderr.write(`${result.detail}\n`);
  } else if (result.status === "conflicts") {
    process.stdout.write(`STATUS: conflicts\n${result.conflicts}${result.conflicts.endsWith("\n") ? "" : "\n"}`);
  } else {
    process.stderr.write(`Error: ${result.detail}\n`);
  }
  process.exitCode = result.exitCode;
  return true;
}
