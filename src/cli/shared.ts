/** Shared CLI utilities used by multiple command modules. */

/**
 * Parses a duration string like "300s", "5m", "1h", "7d" into milliseconds.
 * Throws on invalid format.
 */
export function parseDuration(input: string): number {
  const match = input.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw new Error(
      `Invalid duration format: "${input}". Use <number><unit> where unit is s, m, h, or d (e.g. 300s, 5m, 1h, 7d).`,
    );
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    case "d":
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/** Returns true if args contains --help or -h. */
export function hasHelpFlag(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** Writes text to stdout and exits with code 0. */
export function printHelp(text: string): void {
  process.stdout.write(text + "\n");
  process.exit(0);
}

/** Renders an aligned subcommand listing from a { name: description } map. */
export function printHelpSubcommand(subcommands: Record<string, string>): void {
  const maxLen = Math.max(...Object.keys(subcommands).map((k) => k.length));
  const lines: string[] = [];
  for (const [name, desc] of Object.entries(subcommands)) {
    lines.push(`  ${name.padEnd(maxLen + 2)}${desc}`);
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

/** Reads --flag value or --flag=value from args array. Returns undefined if not present. */
export function readOption(args: string[], name: string): string | undefined {
  const inline = `${name}=`;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === name) return args[i + 1];
    if (token.startsWith(inline)) return token.slice(inline.length);
  }
  return undefined;
}

/** Reads a required option from args. Exits with error message if missing. */
export function requireOption(args: string[], name: string, usage: string): string {
  const value = readOption(args, name)?.trim();
  if (!value) {
    process.stderr.write(`Missing ${name}.\nUsage: ${usage}\n`);
    process.exit(1);
  }
  return value;
}

/** Levenshtein distance between two strings. */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    dp[i] = [i];
    for (let j = 1; j <= n; j++) {
      if (i === 0) { dp[i][j] = j; continue; }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/** Find the closest match for `input` among `candidates`. Returns undefined if no candidate is closer than half the input length. */
export function findClosestMatch(input: string, candidates: string[]): string | undefined {
  let best = Infinity;
  let bestMatch: string | undefined;
  for (const c of candidates) {
    const d = levenshteinDistance(input, c);
    if (d < best) { best = d; bestMatch = c; }
  }
  // Only suggest if it's reasonably close (within 80% of the input length,
  // with a floor of 3 so short words can still get suggestions).
  if (bestMatch && best <= Math.max(3, Math.ceil(input.length * 0.8))) return bestMatch;
  return undefined;
}

/** Determine if a command word looks like a subcommand of the given group. Returns the normalized group key if it is. */
export function isTopLevelGroup(word: string): boolean {
  const groups = [
    "version", "skill-path", "source-path", "update", "get-ready",
    "uninstall", "status", "merge-branch", "mcp", "dashboard", "daemon",
    "control-plane", "step", "logs", "logs-tail", "worktree", "autoresearch",
    "workflow", "restart", "nudge", "doctor",
  ];
  if (groups.includes(word)) return true;
  return false;
}

/** Known top-level command groups for suggestion */
export const KNOWN_TOP_LEVEL = [
  "version", "skill-path", "source-path", "update", "get-ready",
  "uninstall", "status", "merge-branch", "mcp", "dashboard", "daemon",
  "control-plane", "step", "logs", "logs-tail", "worktree", "autoresearch",
  "workflow", "restart", "nudge", "doctor",
];

/**
 * Print an unknown-command error to stderr with nearest-match suggestion and exit 1.
 * @param word - The unknown command word to match against candidates.
 * @param candidates - Known commands to suggest from.
 * @param group - Optional group prefix for display (e.g. "workflow cancel" instead of just "cancel").
 */
export function reportUnknownCommand(word: string, candidates: string[], group?: string): void {
  const fullCommand = group ? `${group} ${word}` : word;
  const suggestion = findClosestMatch(word, candidates);
  process.stderr.write(`Unknown command: "${fullCommand}"\n`);
  if (suggestion) {
    const groupHint = group ? `${group} ` : "";
    process.stderr.write(`Did you mean: tamandua ${groupHint}${suggestion}?\n`);
  }
  const helpArg = group ? `${group} --help` : "--help";
  process.stderr.write(`Run tamandua ${helpArg} for available commands.\n`);
  process.exit(1);
}

/** Determines whether the update warning should be suppressed for the given command. */
export function shouldSkipUpdateWarning(group: string, action: string): boolean {
  if (group === "update") return true;
  if (group === "version" || group === "--version" || group === "-v") return true;
  if (group === "step" && (action === "peek" || action === "claim")) return true;
  if (group === "nudge") return true;
  if (group === "merge-branch") return true;
  return false;
}
