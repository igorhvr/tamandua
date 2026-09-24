#!/usr/bin/env node
// storm-chain-summarize.mjs — turn a storm-chain evidence dir into
// `chain-summary.json` + `chain-report.md` (Storm O12-REPIN US-008).
//
// Pure stdlib + the pure `storm-chain-report.mjs` shapers. Reads
// `chain-files.txt`, `results.tsv`, `meta-acquire.env`, `meta-release.env`,
// `lock-stat-before.txt` / `lock-stat-after.txt` and writes the summary that
// records file counts, missing files, per-file exit codes, totals and verdict.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildChainSummary,
  parseChainFileList,
  validateChainSummary,
} from "./storm-chain-report.mjs";

const DEFAULT_RUN7_CANDIDATES = [
  process.env.STORM_CHAIN_RUN7_FILES,
  "/opt/tamandua-storm-seed.Hn3vQ8kL/torture-test/var/results/storm-chain-2026-09-15T12-01-28Z/chain-files.txt",
  "/opt/tamandua-storm-seed.Hn3vQ8kL/torture-test/var/results/storm-chain-2026-09-15T11-31-08Z/chain-files.txt",
].filter(Boolean);

function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("=")) continue;
    const idx = trimmed.indexOf("=");
    out[trimmed.slice(0, idx)] = trimmed.slice(idx + 1);
  }
  return out;
}

function readResultsTsv(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split("\t");
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split("\t");
    if (parts.length < header.length) continue;
    const row = {};
    for (let i = 0; i < header.length; i += 1) row[header[i]] = parts[i];
    rows.push(row);
  }
  return rows;
}

function resolveRun7() {
  for (const candidate of DEFAULT_RUN7_CANDIDATES) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const text = fs.readFileSync(candidate, "utf8");
    return { path: candidate, text, files: parseChainFileList(text) };
  }
  return null;
}

function main() {
  const evid = process.argv[2];
  if (!evid) {
    process.stderr.write("usage: storm-chain-summarize.mjs <evidence-dir>\n");
    process.exit(2);
  }
  const chainFilesText = fs.readFileSync(path.join(evid, "chain-files.txt"), "utf8");
  const files = parseChainFileList(chainFilesText);
  const rows = readResultsTsv(path.join(evid, "results.tsv"));
  const acquire = readEnvFile(path.join(evid, "meta-acquire.env"));
  const release = readEnvFile(path.join(evid, "meta-release.env"));

  const statBefore = fs.existsSync(path.join(evid, "lock-stat-before.txt"))
    ? fs.readFileSync(path.join(evid, "lock-stat-before.txt"), "utf8").trim()
    : null;
  const statAfter = fs.existsSync(path.join(evid, "lock-stat-after.txt"))
    ? fs.readFileSync(path.join(evid, "lock-stat-after.txt"), "utf8").trim()
    : null;
  const untouched = statBefore !== null && statAfter !== null ? statBefore === statAfter : null;

  const run7 = resolveRun7();
  const run7Info = run7
    ? {
        path: run7.path,
        file_count: run7.files.length,
        byte_match: chainFilesText === run7.text,
        set_match:
          [...files].sort().join("\n") === [...run7.files].sort().join("\n"),
      }
    : { path: null, file_count: null, byte_match: null, set_match: null };

  const summary = buildChainSummary({
    files,
    rows,
    lock: {
      path: acquire.lock,
      submit_iso: acquire.submit_iso,
      submit_epoch: acquire.submit_epoch,
      acquire_iso: acquire.acquire_iso,
      acquire_epoch: acquire.acquire_epoch,
      release_iso: release.release_iso,
      release_epoch: release.release_epoch,
      holder_pid: acquire.holder_pid,
      stat_before: statBefore,
      stat_after: statAfter,
      untouched,
    },
    generatedAtUtc: new Date().toISOString(),
    evidenceDir: evid,
    repo: acquire.repo ?? null,
    head: acquire.head ?? null,
    harnessGuardEnv: acquire.harness_guard_env ?? null,
    run7: run7Info,
    task: "O12-REPIN",
    story: "US-008",
  });

  const validation = validateChainSummary(summary);
  const summaryPath = path.join(evid, "chain-summary.json");
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

  const lines = [];
  lines.push("# O12-REPIN US-008 storm chain run record");
  lines.push("");
  lines.push(`- Generated: ${summary.generated_at_utc}`);
  lines.push(`- Evidence dir: \`${evid}\``);
  lines.push(`- Repo: \`${summary.repo}\`${summary.head ? ` @ ${summary.head}` : ""}`);
  lines.push(`- Mode: one \`node --test\` per file, serially, under one held \`flock --exclusive ${summary.lock.path}\``);
  lines.push(`- Env: \`${summary.harness_guard_env}\``);
  lines.push(`- Lock submit: ${summary.lock.submit_iso}`);
  lines.push(
    summary.lock.wait_seconds === null
      ? `- Lock acquired: ${summary.lock.acquire_iso}`
      : `- Lock acquired: ${summary.lock.acquire_iso} (waited ${summary.lock.wait_seconds.toFixed(1)}s)`,
  );
  lines.push(
    summary.lock.held_seconds === null
      ? `- Lock released: ${summary.lock.release_iso}`
      : `- Lock released: ${summary.lock.release_iso} (held ${summary.lock.held_seconds.toFixed(1)}s)`,
  );
  lines.push(`- Lock untouched: ${summary.lock.untouched}`);
  lines.push(`- Run #7 chain-files byte match: ${run7Info.byte_match} (${run7Info.path})`);
  lines.push(`- Files expected/observed: ${summary.file_count_expected}/${summary.file_count_observed}`);
  lines.push(`- Missing files: ${summary.missing_files.length}`);
  lines.push(`- Red files: ${summary.red_file_count}`);
  lines.push(
    `- Totals: tests=${summary.totals.tests} pass=${summary.totals.pass} fail=${summary.totals.fail} skipped=${summary.totals.skipped}`,
  );
  lines.push(`- Verdict: **${summary.verdict}**`);
  lines.push("");
  lines.push("## Per-file results");
  lines.push("");
  lines.push("| # | rc | tests | pass | fail | skipped | ms | file |");
  lines.push("|---|----|-------|------|------|---------|----|------|");
  for (const row of summary.results) {
    lines.push(
      `| ${row.idx} | ${row.rc} | ${row.tests} | ${row.pass} | ${row.fail} | ${row.skipped} | ${row.duration_ms} | \`${row.file}\` |`,
    );
  }
  lines.push("");
  if (summary.red_files.length > 0) {
    lines.push("## Red files");
    lines.push("");
    for (const red of summary.red_files) {
      lines.push(`- \`${red.file}\` rc=${red.rc} tests=${red.tests} fail=${red.fail} log=${red.log}`);
    }
    lines.push("");
  }
  fs.writeFileSync(path.join(evid, "chain-report.md"), `${lines.join("\n")}\n`);

  process.stdout.write(
    `summarize: files=${summary.file_count_observed}/${summary.file_count_expected} reds=${summary.red_file_count} tests=${summary.totals.tests} pass=${summary.totals.pass} fail=${summary.totals.fail} skipped=${summary.totals.skipped} verdict=${summary.verdict}\n`,
  );
  if (!validation.ok) {
    process.stderr.write(`summary validation failed: ${validation.problems.join("; ")}\n`);
    process.exit(1);
  }
}

main();
