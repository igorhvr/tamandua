/**
 * Matchlock Hermes output/session-trailer handling.
 *
 * MTLK-HERMES US-001: recover the final `session_id:` trailer that the Hermes
 * quiet mode prints as `\nsession_id: <id>` to **stderr** (line 4062/4086 of
 * the CLI source). The helper prefers stderr, falls back to stdout, and strips
 * the trailer line from the assistant text so STATUS classification is not
 * confused. Missing / empty evidence is surfaced as `null`, never fabricated.
 */

/** The regex matching a bare `session_id: <id>` trailer line. */
const SESSION_ID_LINE = /^session_id:\s*(\S+)\s*$/;

/** Session id, source stream, or null when absent. */
export interface SessionTrailer {
  sessionId: string | null;
  source: "stderr" | "stdout" | null;
}

/**
 * Extract the final session_id trailer, preferring stderr. Handles rotated or
 * missing evidence by returning `{ sessionId: null }` (the caller must treat a
 * missing trailer as incomplete accounting, not a success).
 */
export function extractSessionTrailer(
  stdout: string,
  stderr: string,
): SessionTrailer {
  for (const [text, source] of [
    [stderr, "stderr"],
    [stdout, "stdout"],
  ] as const) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(SESSION_ID_LINE);
      if (m) return { sessionId: m[1], source };
    }
  }
  return { sessionId: null, source: null };
}

/**
 * Remove the `session_id:` trailer line(s) from text so downstream STATUS /
 * REPORT parsing sees only assistant output. No other content is altered.
 */
export function stripSessionTrailer(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !SESSION_ID_LINE.test(line))
    .join("\n")
    .trim();
}
