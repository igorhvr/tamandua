/**
 * Executable Matchlock launch-gate demo (G9 EXIT-CODE-AND-REMEDIES, US-005).
 *
 * WHAT THIS IS. A tiny real CLI-shaped program that composes the launch gate's
 * real modules against a REAL store on disk:
 *
 *     observeStore(store)
 *       -> adaptStoreObservation(observation, "required", caller config)
 *       -> evaluateGate(...)
 *       -> detectStoreHolders(holderStores, { listOpenFileHolders: () => [] })
 *       -> renderGateRemedyText(...)
 *       -> exitCodeForGateOutcome(verdict)  ->  process.exit(status)
 *
 * It prints the surface summary line an operator-facing CLI prints before the
 * generated remedy ("Matchlock launch refused" / "Matchlock launch allowed"),
 * writes the remedy text to STDERR and exits with the status the gate's single
 * mapping returns. Stdout carries no remedy: an operator reading a pipe gets
 * the refusal on stderr, exactly as a refusal should be.
 *
 * SCOPE, STATED HONESTLY. This proves verdict-to-exit propagation at the
 * MODULE boundary. The interactive wiring (`tamandua matchlock pi|hermes`, the
 * swap surface and the scheduler) is G8's story and does not exist yet, so
 * this demo does not claim to prove an end-to-end interactive refusal.
 *
 * WHAT IT DOES NOT DO. It creates no VM, makes no RPC, writes nothing, reads
 * no HOME and never invokes the matchlock binary. It has no child_process
 * import and no spawn/exec/fork call, so it cannot start anything: the only
 * node process involved is this one. It reads exactly two caller-supplied
 * paths — the store's 100-byte header/sidecars through `observeStore`, and the
 * guest-visible config it is told to render into the remedy. Nothing outside
 * those paths (and the already-built modules under dist/) is touched.
 *
 * The holder probe is injected as an empty list on purpose: holding detection
 * is a separate concern (G6) and this demo must never shell out to `lsof`. A
 * failed-looking holder observation is rendered as informational, never as a
 * refusal, so an empty probe changes no verdict.
 *
 * USAGE
 *
 *     node tests/fixtures/gate-refusal-demo.mjs \
 *       --store <path> --config <path> \
 *       --journal-mode wal|delete --relaunch <command>
 *
 * `--journal-mode` is the caller's claim about the guest-visible effective
 * setting; the demo cross-checks it against the `journal_mode` declared in
 * `--config` and fails loudly if they disagree, so the config observation
 * handed to the gate is a real read rather than a hard-coded value.
 *
 * Exit statuses: 0 when the gate allows; the launch-gate refusal status (78)
 * when it refuses; 2 for bad usage and 3 for a config the demo cannot
 * cross-check. The refusal status is never written as a literal here — it
 * comes from `exitCodeForGateOutcome`, the one mapping every caller uses.
 */

import fs from "node:fs";
import path from "node:path";

const SURFACE_REFUSED = "Matchlock launch refused";
const SURFACE_ALLOWED = "Matchlock launch allowed";

const DIST = new URL("../../dist/installer/matchlock/", import.meta.url);

const USAGE =
  "usage: node tests/fixtures/gate-refusal-demo.mjs " +
  "--store <path> --config <path> --journal-mode wal|delete --relaunch <command>";

const KNOWN_FLAGS = new Set(["--store", "--config", "--journal-mode", "--relaunch"]);

/** Print a demo failure to stderr and exit with an operator-visible status. */
function fail(message, status = 2) {
  process.stderr.write(`gate-refusal-demo: ${message}\n${USAGE}\n`);
  process.exit(status);
}

/** Parse the four named options; nothing positional, nothing implicit. */
function parseArgs(argv) {
  const parsed = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!KNOWN_FLAGS.has(flag)) {
      fail(`unrecognised argument ${JSON.stringify(flag)}`);
    }
    if (parsed.has(flag)) {
      fail(`${flag} was supplied twice`);
    }
    const value = argv[index + 1];
    if (value === undefined) {
      fail(`${flag} requires a value`);
    }
    parsed.set(flag, value);
    index += 1;
  }
  return parsed;
}

/**
 * Read the guest-visible effective journal mode from the supplied config.
 *
 * The demo refuses to invent an observation: the gate's `not-delete-config`
 * finding depends on what the guest would actually read, so a missing or
 * unparseable config is a demo failure (status 3), never a guessed "delete".
 */
function readConfiguredJournalMode(configPath) {
  let text;
  try {
    text = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    fail(
      `cannot read --config ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      3,
    );
  }

  const match = /^[ \t]*journal_mode:[ \t]*["']?([A-Za-z][A-Za-z0-9_-]*)["']?[ \t]*(?:#.*)?$/m.exec(
    text,
  );
  if (match === null) {
    fail(`--config ${configPath} does not declare a journal_mode`, 3);
  }
  return match[1].toLowerCase();
}

const args = parseArgs(process.argv.slice(2));
for (const flag of KNOWN_FLAGS) {
  if (!args.has(flag)) fail(`${flag} is required`);
}

const storePath = path.resolve(args.get("--store"));
const configPath = path.resolve(args.get("--config"));
const requestedMode = args.get("--journal-mode").toLowerCase();
const relaunchCommand = args.get("--relaunch");

if (requestedMode !== "wal" && requestedMode !== "delete") {
  fail(`--journal-mode must be wal or delete, got ${JSON.stringify(requestedMode)}`);
}

const configuredMode = readConfiguredJournalMode(configPath);
if (configuredMode !== requestedMode) {
  fail(
    `--journal-mode ${requestedMode} disagrees with the journal_mode ${configuredMode} ` +
      `declared in ${configPath}`,
    3,
  );
}

const { observeStore } = await import(new URL("store-header.js", DIST));
const { adaptStoreObservation } = await import(new URL("store-observation-adapter.js", DIST));
const { evaluateGate } = await import(new URL("launch-gate.js", DIST));
const { detectStoreHolders } = await import(new URL("store-holder-detect.js", DIST));
const { renderGateRemedyText } = await import(new URL("gate-remedy-text.js", DIST));
const { exitCodeForGateOutcome } = await import(new URL("gate-exit-code.js", DIST));

const observation = observeStore(storePath);

// Filesystem identity for the holder probe. A confirmed-absent store has no
// inode, so it contributes no holder path and detection still runs.
let stats = null;
try {
  stats = fs.statSync(storePath);
} catch {
  stats = null;
}

const store = adaptStoreObservation(observation, "required", {
  ...(stats === null ? {} : { dev: String(stats.dev), ino: String(stats.ino) }),
  config: {
    journalMode: configuredMode === "wal" || configuredMode === "delete" ? configuredMode : "other",
    source: `guest config ${configPath}`,
    observed: true,
  },
});

const stores = [store];
const verdict = evaluateGate({
  inventoryComplete: true,
  incompleteReasons: [],
  stores,
});

// `detectStoreHolders` speaks in filesystem identity, so map the evaluated
// store's identity into the holder-probe shape instead of passing the richer
// object (whose `dev`/`ino` live under `identity`).
const holderStores = stores
  .filter((candidate) => candidate.identity !== null)
  .map((candidate) => ({
    canonicalPath: candidate.identity.canonicalPath,
    dev: String(candidate.identity.dev ?? ""),
    ino: String(candidate.identity.ino ?? ""),
  }));

// The probe is injected empty on purpose: no process is inspected here, and a
// holder listing is informational only, so it cannot change this verdict.
const holderDetection = detectStoreHolders(holderStores, {
  listOpenFileHolders: () => [],
});

const remedy = renderGateRemedyText({
  verdict,
  holderDetection,
  stores,
  relaunchCommand,
  guestConfigPath: configPath,
});

const surfaceLine =
  verdict.action === "allow" ? SURFACE_ALLOWED : SURFACE_REFUSED;
process.stderr.write(
  `${surfaceLine} (${verdict.findings.length} finding(s), ${stores.length} store(s) evaluated)\n\n`,
);
process.stderr.write(remedy);

process.exit(exitCodeForGateOutcome(verdict));
