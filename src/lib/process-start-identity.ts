import fs from "node:fs";

/** Stable Linux kernel process-start identity, used with a PID to prevent ABA reuse. */
export function getProcessStartIdentity(pid: number): string | null {
  if (process.platform !== "linux") return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const afterComm = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const startTime = afterComm[19];
    return /^\d+$/.test(startTime ?? "") ? `proc:${startTime}` : null;
  } catch {
    return null;
  }
}
