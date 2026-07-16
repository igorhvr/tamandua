#!/usr/bin/env node
/**
 * scripts/update-coordinator.mjs — Exact-arity, bounded CLI adapter for the update protocol.
 *
 * Commands:
 *   acquire <mode> <updaterPid> <topology> <artifacts> <readiness>
 *   inspect
 *   record-guardian-cas <token> <expectedPhase> <expectedOwnerPid> <expectedOwnerIdentity> <guardianPid> <expectedGuardianIdentity>
 *   fail <token> <expectedPhase> <expectedOwnerPid> <expectedOwnerIdentity> <reason> <details>
 *
 * Protocol: exact-arity check before any argument validation.
 * All external string values bounded at 4096 UTF-8 bytes.
 * All diagnostics truncated to 4096 UTF-8 bytes with code-point-aware truncation.
 */

import {
  acquire,
  inspect,
  recordGuardian,
  fail,
} from "./update-protocol.mjs";

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_JSON_LENGTH = 65536; // success stdout cap including newline
const STDERR_BOUND = 4096; // diagnostic stderr cap including newline
const STRING_BOUND = 4096; // max UTF-8 bytes for external string values
const PID_RE = /^[1-9][0-9]{0,15}$/;

// ── Arity tables (command name → expected args.length including command) ──────

const ARITY = Object.freeze({
  acquire: 6,
  inspect: 1,
  "record-guardian-cas": 7,
  fail: 7,
});

// ── UTF-8 code-point-aware diagnostic truncation ─────────────────────────────

/**
 * Truncate a message to fit within STDERR_BOUND bytes (4096), reserving
 * one byte for the final newline. Iterates code points (not bytes / UTF-16
 * units), appends each complete code point only while the accumulated byte
 * total stays ≤ 4095, then appends "\n" outside the loop. Returns a string
 * that never exceeds 4096 UTF-8 bytes and never contains U+FFFD introduced
 * by byte-boundary slicing.
 */
function truncateDiagnostic(message) {
  // Reserve one byte for the trailing newline.
  const limit = STDERR_BOUND - 1;
  if (Buffer.byteLength(message, "utf-8") <= limit) {
    return message + "\n";
  }
  let out = "";
  let byteLen = 0;
  for (const cp of message) {
    const cpBytes = Buffer.byteLength(cp, "utf-8");
    if (byteLen + cpBytes > limit) break;
    out += cp;
    byteLen += cpBytes;
  }
  return out + "\n";
}

// ── Output helpers ───────────────────────────────────────────────────────────

function emit(outcome) {
  const json = JSON.stringify(outcome);
  if (Buffer.byteLength(json, "utf-8") + 1 > MAX_JSON_LENGTH) {
    process.stderr.write("Output exceeds maximum length\n");
    process.exit(2);
  }
  process.stdout.write(json + "\n");
}

function emitError(message) {
  process.stderr.write(truncateDiagnostic(String(message)));
  process.exit(2);
}

// ── Argument helpers ─────────────────────────────────────────────────────────

function safePidArg(args, index) {
  const raw = args[index];
  if (typeof raw !== "string") {
    emitError("Invalid argument");
  }
  if (Buffer.byteLength(raw, "utf-8") > STRING_BOUND) {
    emitError("Invalid argument");
  }
  if (!PID_RE.test(raw)) {
    emitError("Invalid argument");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    emitError("Invalid argument");
  }
  if (String(parsed) !== raw) {
    emitError("Invalid argument");
  }
  return parsed;
}

function safeBoundArg(args, index) {
  const raw = args[index];
  if (typeof raw !== "string") {
    emitError("Invalid argument");
  }
  if (Buffer.byteLength(raw, "utf-8") > STRING_BOUND) {
    emitError("Invalid argument");
  }
  return raw;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  // Step 1: identify command from argv[0] only
  if (args.length === 0) {
    emitError(
      "Usage: update-coordinator.mjs <acquire|inspect|record-guardian-cas|fail> [args...]",
    );
  }

  const command = args[0];

  // Step 2: unknown command → fixed message, never echo it
  if (!Object.hasOwn(ARITY, command)) {
    emitError("Unknown command");
  }

  // Step 3: exact arity check before touching any argument
  const expectedLen = ARITY[command];
  if (args.length < expectedLen || args.length > expectedLen) {
    emitError(`Invalid argument count for ${command}`);
  }

  // Step 4: only after arity succeeds, validate & invoke
  try {
    switch (command) {
      case "acquire": {
        const mode = safeBoundArg(args, 1);
        const updaterPid = safePidArg(args, 2);
        const topology = safeBoundArg(args, 3);
        const artifacts = safeBoundArg(args, 4);
        const readiness = safeBoundArg(args, 5);

        const result = acquire(mode, updaterPid, topology, artifacts, readiness);
        emit(result);
        break;
      }

      case "inspect": {
        const result = inspect();
        emit({ gate: result });
        break;
      }

      case "record-guardian-cas": {
        const token = safeBoundArg(args, 1);
        const expectedPhase = safeBoundArg(args, 2);
        const expectedOwnerPid = safePidArg(args, 3);
        const expectedOwnerIdentity = safeBoundArg(args, 4);
        const guardianPid = safePidArg(args, 5);
        const expectedGuardianIdentity = safeBoundArg(args, 6);

        const result = recordGuardian(
          token,
          expectedPhase,
          expectedOwnerPid,
          expectedOwnerIdentity,
          guardianPid,
          expectedGuardianIdentity,
        );
        if (result.changed) {
          emit(result);
        } else {
          emitError("Record-guardian refused");
        }
        break;
      }

      case "fail": {
        const token = safeBoundArg(args, 1);
        const expectedPhase = safeBoundArg(args, 2);
        const expectedOwnerPid = safePidArg(args, 3);
        const expectedOwnerIdentity = safeBoundArg(args, 4);
        const reason = safeBoundArg(args, 5);
        const details = safeBoundArg(args, 6);

        const result = fail(
          token,
          expectedPhase,
          expectedOwnerPid,
          expectedOwnerIdentity,
          reason,
          details,
        );
        if (result.changed) {
          emit(result);
        } else {
          emitError("Fail refused");
        }
        break;
      }
    }
  } catch (e) {
    if (e instanceof Error) {
      emitError(e.message);
    } else {
      emitError("Internal error");
    }
  }
}

main();
