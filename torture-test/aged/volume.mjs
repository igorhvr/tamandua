// volume.mjs — VOLUME-ONLY synthetic event emission for the aged-state seed.
//
// The full corpus requires >=500000 LOGICAL event records.  Ordinary
// lifecycle records are generated through the real APIs; the remainder is
// produced through the REAL emitEvent with an explicitly synthetic,
// non-lifecycle, run-bound event name (aged.volume.seed) and a unique seed
// sequence.  We never forge step claims/completions, usage, merges, or
// successes.  The native emitter writes BOTH the run stream and all.jsonl;
// those are physical copies of the same logical records and are never
// double-counted as logical events.  Rotation of the global file is product
// policy (20MB cap, 3 archives); per-run files are the retained authoritative
// stream and are hashed/counted by the census.

import fs from "node:fs";
import path from "node:path";
import { utcNow, VOLUME_EVENT_NAME } from "./seedcommon.mjs";

// Emit `count` volume-only events bound to `runId` via the real product
// emitEvent.  Returns a per-batch receipt.
export function emitVolumeEvents({ events, runId, workflowId, count, sequenceStart }) {
  const emitted = [];
  for (let i = 0; i < count; i += 1) {
    const seq = sequenceStart + i;
    events.emitEvent({
      ts: new Date().toISOString(),
      event: VOLUME_EVENT_NAME,
      runId,
      workflowId,
      seed_sequence: seq,
      detail: `aged-state volume-only synthetic record #${seq} for run ${runId.slice(0, 8)}`,
    });
    emitted.push(seq);
  }
  return { count, firstSeq: sequenceStart, lastSeq: sequenceStart + count - 1 };
}
