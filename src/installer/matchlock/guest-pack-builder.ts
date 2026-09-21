/**
 * Portable read-only guest helper pack builder.
 *
 * Produces the version-matched Matchlock guest pack (design section 7.1),
 * rooted at /workspace/runtime inside the image:
 *
 *   /workspace/runtime/
 *     bin/tamandua          POSIX-sh launcher -> guest CLI entry
 *     bin/tamandua-bridge   POSIX-sh launcher -> guest bridge service entry
 *     lib/                  self-contained ESM closure (Node core ONLY)
 *     skills/tamandua-agents/SKILL.md   real readable guest skill
 *     manifest.json         helper/build/protocol identity + capability list
 *     package.json          {"type":"module"}
 *
 * The closure is the COMPILED guest runtime modules from this checkout's
 * dist/installer/matchlock/guest-* / guest-service / guest-cli entries. The
 * builder walks the compiled static import graph and refuses any module that
 * reaches outside dist/installer/matchlock or imports a non-core package —
 * that is the guarantee that the pack never bundles the unrestricted host
 * CLI, its DB/admin fallback, host node_modules or native binaries.
 *
 * The pack contains no autoinstall and no host PATH/dotfiles: the image
 * supplies Node >= 22 and /bin/sh; the launchers resolve `node` from the
 * (prepended) image PATH.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BRIDGE_OPS,
  GUEST_BRIDGE_PROTOCOL_VERSION,
  GUEST_PACK_LAYOUT_VERSION,
  SUITE_BRIDGE_OPS,
} from "./guest-protocol.js";

export class GuestPackError extends Error {}

export interface GuestPackOptions {
  /** Target pack root (e.g. /workspace/runtime). Must not already exist. */
  targetDir: string;
  /** Compiled guest runtime root (default: <checkout>/dist). */
  distRoot?: string;
  /** Guest skill asset directory (default: <checkout>/src/installer/matchlock/guest-assets). */
  assetDir?: string;
  /** Matching Tamandua build version (default: read from <distRoot>/version). */
  helperBuildVersion?: string;
  /** Injectable clock for deterministic manifests (tests). */
  builtAt?: string;
}

export interface GuestPackResult {
  targetDir: string;
  manifest: GuestPackManifest;
  closureModules: string[];
  writtenFiles: string[];
}

export interface GuestPackManifest {
  name: string;
  packLayoutVersion: number;
  protocolVersion: number;
  tamanduaBuildVersion: string;
  helperProtocolVersion: string;
  capabilities: string[];
  unsupported: string[];
  entries: { cli: string; service: string; test: string };
  suite: {
    ops: string[];
    note: string;
  };
  builtAt: string;
  modules: string[];
}

const ENTRY_REL = {
  cli: "installer/matchlock/guest-cli-entry.js",
  service: "installer/matchlock/guest-service-entry.js",
  test: "installer/matchlock/guest-suite-cli-entry.js",
};

/**
 * Shared pure cores that ship inside the portable pack as explicit closure
 * roots even before a guest entry imports them (US-005 merge core). They are
 * Node-core only, so the walker accepts them with zero non-core imports and no
 * host node_modules/native binaries.
 */
const SHARED_CORE_REL = ["installer/matchlock/merge-core.js"];

const WALK_ROOTS = [ENTRY_REL.cli, ENTRY_REL.service, ENTRY_REL.test, ...SHARED_CORE_REL];

const ALLOWED_DIR_REL = "installer/matchlock";

function defaultDistRoot(fromDir: string): string {
  // <dist>/installer/matchlock -> <dist>
  return path.resolve(fromDir, "..", "..");
}

function defaultAssetDir(fromDir: string): string {
  // <dist>/installer/matchlock -> <repo>/src/installer/matchlock/guest-assets
  const distRoot = defaultDistRoot(fromDir);
  const repoRoot = path.resolve(distRoot, "..");
  return path.join(repoRoot, "src", "installer", "matchlock", "guest-assets");
}

const CORE_PREFIX = "node:";

/** Regexes capturing static import specifiers in compiled ESM. */
const FROM_RE = /\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|[;\n{]\s*)import\s*["']([^"']+)["']/g;

function collectSpecifiers(js: string): string[] {
  const specs = new Set<string>();
  let m: RegExpExecArray | null;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(js)) !== null) specs.add(m[1]);
  BARE_IMPORT_RE.lastIndex = 0;
  while ((m = BARE_IMPORT_RE.exec(js)) !== null) specs.add(m[1]);
  return [...specs];
}

/**
 * Walk the compiled static import graph starting at `entries`. Throws
 * GuestPackError when a module imports a non-core package or resolves
 * outside the allowed dist subdirectory.
 */
export function walkGuestClosure(
  distRoot: string,
  entries: string[],
): { modules: string[]; errors: string[] } {
  const allowedRoot = path.resolve(distRoot, ALLOWED_DIR_REL);
  const seen = new Set<string>();
  const errors: string[] = [];
  const queue = [...entries];

  while (queue.length > 0) {
    const rel = queue.shift()!;
    const abs = path.resolve(distRoot, rel);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let js: string;
    try {
      js = fs.readFileSync(abs, "utf-8");
    } catch (err) {
      errors.push(`cannot read compiled module ${rel}: ${(err as Error).message}`);
      continue;
    }
    for (const spec of collectSpecifiers(js)) {
      if (spec.startsWith(CORE_PREFIX)) continue; // Node core is image-provided.
      if (!spec.startsWith(".")) {
        errors.push(
          `module ${rel} imports non-core package "${spec}" — the guest pack must be Node-core only`,
        );
        continue;
      }
      const resolved = path.resolve(path.dirname(abs), spec);
      const resolvedRel = path.relative(allowedRoot, resolved);
      if (resolvedRel.startsWith("..") || path.isAbsolute(resolvedRel)) {
        errors.push(
          `module ${rel} resolves outside the allowed guest runtime dir (${resolved})`,
        );
        continue;
      }
      const relFromDist = path.relative(distRoot, resolved);
      queue.push(relFromDist);
    }
  }
  const modules = [...seen].sort();
  return { modules, errors };
}

function readBuildVersion(distRoot: string): string {
  try {
    const content = fs.readFileSync(path.join(distRoot, "version"), "utf-8").trim();
    return content || "unknown";
  } catch {
    return "unknown";
  }
}

function writeFile(filePath: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, { mode });
}

/** Build the guest pack into a fresh target directory. */
export function buildGuestPack(opts: GuestPackOptions): GuestPackResult {
  const fromDir = path.dirname(fileURLToPath(import.meta.url));
  const distRoot = opts.distRoot ? path.resolve(opts.distRoot) : defaultDistRoot(fromDir);
  const targetDir = path.resolve(opts.targetDir);
  const helperBuildVersion = opts.helperBuildVersion ?? readBuildVersion(distRoot);
  const builtAt = opts.builtAt ?? new Date().toISOString();
  const assetDir = opts.assetDir ? path.resolve(opts.assetDir) : defaultAssetDir(fromDir);

  if (fs.existsSync(targetDir)) {
    throw new GuestPackError(`target pack directory already exists: ${targetDir}`);
  }
  if (!fs.existsSync(path.resolve(distRoot, ENTRY_REL.cli))) {
    throw new GuestPackError(
      `compiled guest CLI entry not found at ${path.join(distRoot, ENTRY_REL.cli)} — build this checkout first (npm run build)`,
    );
  }

  const { modules, errors } = walkGuestClosure(distRoot, WALK_ROOTS);
  if (errors.length > 0) {
    throw new GuestPackError(`guest closure validation failed:\n  ${errors.join("\n  ")}`);
  }

  const writtenFiles: string[] = [];
  // Copy closure modules preserving the dist-relative layout under lib/.
  for (const abs of modules) {
    const relFromDist = path.relative(distRoot, abs);
    const dest = path.join(targetDir, "lib", relFromDist);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
    writtenFiles.push(path.relative(targetDir, dest));
  }

  // package.json (module type) at root and under lib.
  const pkgJson = JSON.stringify({ name: "tamandua-guest-helper", private: true, type: "module" }, null, 2) + "\n";
  writeFile(path.join(targetDir, "package.json"), pkgJson);
  writeFile(path.join(targetDir, "lib", "package.json"), pkgJson);
  writtenFiles.push("package.json", path.join("lib", "package.json"));

  // Launchers (POSIX sh; image supplies /bin/sh and node >= 22 on PATH).
  const cliLauncher = `#!/bin/sh
# Matchlock guest helper CLI launcher (read-only pack; image supplies node >= 22).
if ! command -v node >/dev/null 2>&1; then
  echo "tamandua: node >= 22 is required in the image PATH to run the guest helper pack" >&2
  exit 1
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/../lib/${ENTRY_REL.cli}" "$@"
`;
  const serviceLauncher = `#!/bin/sh
# Matchlock guest bridge service launcher (exec'd by the controller with the
# dedicated exec pipe attached to stdin/stdout).
if ! command -v node >/dev/null 2>&1; then
  echo "tamandua-bridge: node >= 22 is required in the image PATH" >&2
  exit 1
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/../lib/${ENTRY_REL.service}" "$@"
`;
  const testLauncher = `#!/bin/sh
# Matchlock guest suite test launcher (read-only pack; image supplies node >= 22).
# Executes the exact reviewed command GUEST-locally and speaks the suite
# ledger surface through the guest bridge socket when the host wired a
# suite-capable broker (TAMANDUA_GUEST_SUITE_ENABLED=1). Without that wiring
# the engine degrades to real guest-local execution with explicit incomplete
# evidence — never a native host fallback and never a recorded/replayed green.
if ! command -v node >/dev/null 2>&1; then
  echo "tamandua-test: node >= 22 is required in the image PATH to run the guest helper pack" >&2
  exit 1
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/../lib/${ENTRY_REL.test}" "$@"
`;
  const binDir = path.join(targetDir, "bin");
  writeFile(path.join(binDir, "tamandua"), cliLauncher, 0o755);
  writeFile(path.join(binDir, "tamandua-bridge"), serviceLauncher, 0o755);
  writeFile(path.join(binDir, "tamandua-test"), testLauncher, 0o755);
  writtenFiles.push(
    path.join("bin", "tamandua"),
    path.join("bin", "tamandua-bridge"),
    path.join("bin", "tamandua-test"),
  );

  // Guest skill asset (real readable file; native skill untouched).
  const skillDir = path.join(targetDir, "skills", "tamandua-agents");
  const assetSkillDir = path.join(assetDir, "tamandua-agents");
  if (!fs.existsSync(path.join(assetSkillDir, "SKILL.md"))) {
    throw new GuestPackError(`guest skill asset not found under ${assetSkillDir}`);
  }
  fs.mkdirSync(skillDir, { recursive: true });
  for (const name of fs.readdirSync(assetSkillDir)) {
    fs.copyFileSync(path.join(assetSkillDir, name), path.join(skillDir, name));
    writtenFiles.push(path.join("skills", "tamandua-agents", name));
  }

  const manifest: GuestPackManifest = {
    name: "tamandua-guest-helper",
    packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
    protocolVersion: GUEST_BRIDGE_PROTOCOL_VERSION,
    tamanduaBuildVersion: helperBuildVersion,
    helperProtocolVersion: `${helperBuildVersion}+p${GUEST_BRIDGE_PROTOCOL_VERSION}`,
    // Step ops + local answers are the pack's always-available surface. The
    // six suite ops are deliberately NOT advertised as working capabilities:
    // they are served only when the host wired a suite-capable broker AND the
    // guest bridge service was launched suite-enabled (documented under
    // `suite`), so absence of the host suite service is never hidden.
    // US-004: the read-only run-scoped query ops (step.stories /
    // workflow.status / logs.run) ARE advertised below; they are refused with
    // a typed error when the host did not wire a run-scoped query bridge.
    // US-007: the scoped merge ops (merge.authorize / merge.report) are also
    // advertised; they are refused UNSUPPORTED when the host did not wire a
    // merger-capable merge service (no guest Git is attempted in that case).
    capabilities: [
      "version",
      "help",
      "skill-path",
      ...BRIDGE_OPS.filter((op) => !op.startsWith("suite.")),
    ],
    unsupported: [
      "source-path",
      "update/install/uninstall",
      "step release",
      "workflow lifecycle commands other than status --json (run/list/runs/install/uninstall/stop/pause/resume/delete/wait/fail)",
      "global log enumeration (logs with no run-id / logs <N> / logs #<N>) and logs-tail",
      "suite/ledger without a host-injected suite service (absent ⇒ tamandua-test executes guest-locally with explicit incomplete evidence)",
      "dispatcher child runs",
      "daemon/control-plane",
      "admin/operator/direct DB",
    ],
    entries: {
      cli: `lib/${ENTRY_REL.cli}`,
      service: `lib/${ENTRY_REL.service}`,
      test: `lib/${ENTRY_REL.test}`,
    },
    suite: {
      ops: [...SUITE_BRIDGE_OPS],
      note: "served only when the host injected a suite-capable broker and the guest bridge service was launched with TAMANDUA_GUEST_SUITE_ENABLED=1; otherwise the guest engine degrades to real guest-local execution with explicit incomplete evidence (never a recorded/replayed green)",
    },
    builtAt,
    modules: modules.map((m) => path.relative(distRoot, m)).sort(),
  };
  writeFile(path.join(targetDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writtenFiles.push("manifest.json");

  return {
    targetDir,
    manifest,
    closureModules: modules.map((m) => path.relative(distRoot, m)).sort(),
    writtenFiles: writtenFiles.sort(),
  };
}

/** Re-validate a built pack on disk: closure must remain Node-core only. */
export function validateGuestPack(packRoot: string): { ok: boolean; errors: string[]; modules: string[] } {
  const libRoot = path.join(packRoot, "lib");
  if (!fs.existsSync(path.join(packRoot, "manifest.json"))) {
    return { ok: false, errors: ["manifest.json missing"], modules: [] };
  }
  const entries = [...WALK_ROOTS];
  const { modules, errors } = walkGuestClosure(libRoot, entries);
  return { ok: errors.length === 0, errors, modules };
}
