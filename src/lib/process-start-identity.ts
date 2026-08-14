import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Stable process-start identity, used with a PID to prevent ABA reuse:
 * procfs starttime on linux, `ps -o lstart=` on darwin, null elsewhere.
 */
export function getProcessStartIdentity(pid: number): string | null {
  if (process.platform === "darwin") {
    try {
      const lstart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8", timeout: 5000 }).trim();
      return lstart !== "" ? `ps:${lstart}` : null;
    } catch {
      return null;
    }
  }
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
