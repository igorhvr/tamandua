#!/usr/bin/env node
/**
 * scripts/update-coordinator.mjs — Thin CLI for the update protocol.
 *
 * Emits bounded JSON on stdout, diagnostics on stderr, meaningful nonzero exits.
 *
 * Usage:
 *   node scripts/update-coordinator.mjs acquire <mode> <updaterPid> <topology> <artifacts> <readiness>
 *   node scripts/update-coordinator.mjs inspect
 *   node scripts/update-coordinator.mjs phase-cas <token> <expectedPhase> <newPhase> <expectedOwnerPid> <expectedOwnerIdentity>
 *   node scripts/update-coordinator.mjs record-guardian-cas <token> <guardianPid> <guardianIdentity>
 *   node scripts/update-coordinator.mjs fail <token> <reason> <details>
 */

import {
  acquire,
  inspect,
  casPhase,
  recordGuardian,
  fail,
} from "./update-protocol.mjs";

const MAX_JSON_DEPTH = 10;
const MAX_JSON_LENGTH = 65536;

function emit(outcome) {
  const json = JSON.stringify(outcome);
  if (json.length > MAX_JSON_LENGTH) {
    process.stderr.write("Output exceeds maximum length\n");
    process.exit(2);
  }
  process.stdout.write(json + "\n");
}

function emitError(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

function safeGetArg(args, index) {
  const arg = args[index];
  if (arg === undefined || arg === null) {
    emitError(`Missing required argument at position ${index}`);
  }
  return arg;
}

function safeGetIntArg(args, index, label) {
  const raw = safeGetArg(args, index);
  const parsed = parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    emitError(`Invalid ${label}: ${raw}`);
  }
  return parsed;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    emitError(
      "Usage: update-coordinator.mjs <acquire|inspect|phase-cas|record-guardian-cas|fail> [args...]",
    );
  }

  try {
    switch (command) {
      case "acquire": {
        const mode = safeGetArg(args, 1);
        const updaterPid = safeGetIntArg(args, 2, "updaterPid");
        const topology = safeGetArg(args, 3);
        const artifacts = safeGetArg(args, 4);
        const readiness = safeGetArg(args, 5);

        const result = acquire(
          mode,
          updaterPid,
          topology,
          artifacts,
          readiness,
        );
        emit(result);
        break;
      }

      case "inspect": {
        const result = inspect();
        emit({ gate: result });
        break;
      }

      case "phase-cas": {
        const token = safeGetArg(args, 1);
        const expectedPhase = safeGetArg(args, 2);
        const newPhase = safeGetArg(args, 3);
        const expectedOwnerPid = safeGetIntArg(
          args,
          4,
          "expectedOwnerPid",
        );
        const expectedOwnerIdentity = safeGetArg(args, 5);

        const result = casPhase(
          token,
          expectedPhase,
          newPhase,
          expectedOwnerPid,
          expectedOwnerIdentity,
        );
        if (result.changed) {
          emit(result);
        } else {
          emitError(
            `CAS failed: expected ${expectedPhase} but current is ${result.phase}`,
          );
        }
        break;
      }

      case "record-guardian-cas": {
        const token = safeGetArg(args, 1);
        const guardianPid = safeGetIntArg(args, 2, "guardianPid");
        const guardianIdentity = safeGetArg(args, 3);

        const result = recordGuardian(token, guardianPid, guardianIdentity);
        if (result.changed) {
          emit(result);
        } else {
          emitError(
            `Record-guardian failed: current phase is ${result.phase} (not ACQUIRED)`,
          );
        }
        break;
      }

      case "fail": {
        const token = safeGetArg(args, 1);
        const reason = safeGetArg(args, 2);
        const details = safeGetArg(args, 3);

        const result = fail(token, reason, details);
        if (result.changed) {
          emit(result);
        } else {
          emitError(
            `Fail refused: current phase is ${result.phase}, token mismatch, or already failed`,
          );
        }
        break;
      }

      default:
        emitError(
          `Unknown command: ${command}. Use acquire, inspect, phase-cas, record-guardian-cas, or fail.`,
        );
    }
  } catch (e) {
    emitError(e.message);
  }
}

main();
