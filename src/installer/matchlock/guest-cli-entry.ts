/**
 * Guest CLI process entry point (compiled into the RO helper pack and invoked
 * by bin/tamandua). Thin adapter between the process and runGuestCli.
 *
 * Node-core only — safe for the guest pack closure.
 */

import { runGuestCli } from "./guest-cli.js";

function envGet(name: string): string | undefined {
  return process.env[name];
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const argv = ["tamandua", ...process.argv.slice(2)];
  const result = await runGuestCli(argv, {
    cwd: process.cwd(),
    envGet,
    writeOut: (text) => process.stdout.write(text),
    writeErr: (text) => process.stderr.write(text),
    readStdin,
  });
  process.exitCode = result.exitCode;
}

main().catch((err: unknown) => {
  process.stderr.write(`tamandua: internal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
