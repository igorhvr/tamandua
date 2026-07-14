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

/** Determines whether the update warning should be suppressed for the given command. */
export function shouldSkipUpdateWarning(group: string, action: string): boolean {
  if (group === "update") return true;
  if (group === "version" || group === "--version" || group === "-v") return true;
  if (group === "step" && (action === "peek" || action === "claim")) return true;
  if (group === "nudge") return true;
  if (group === "merge-branch") return true;
  return false;
}
