/**
 * IMAGE-HYGIENE: the derived OCI image must not inherit the base image's ssh
 * host keys or root authorized_keys.
 *
 * The base image (`igorhvr/bedlam-ubuntu`) deliberately bakes
 * `/etc/ssh/ssh_host_{rsa,ecdsa,ed25519}_key` plus their `.pub` files and a
 * root `/root/.ssh/authorized_keys` for its own use. A derived image inherits
 * those bytes verbatim, so every consumer of `igorhvr/tamandua` would present
 * the SAME host identity (the "private" host key ships inside a public image,
 * so host authentication is not based on a secret) and inherit a root access
 * grant. `oci-container/Dockerfile` therefore removes exactly those seven
 * files and fail-closes the build if any survives.
 *
 * This test pins that intent statically so a future Dockerfile edit cannot
 * silently drop the removal step (nothing else in the repo exercises the OCI
 * image, so without this file the omission class is invisible).
 *
 * It is pure file reading: no node:child_process, no daemon, no `dist/`
 * imports — hence the parallel lane, and deliberately no entry in
 * `tests/serial-files.txt`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DOCKERFILE_PATH = resolve(REPO_ROOT, "oci-container", "Dockerfile");

const dockerfile = readFileSync(DOCKERFILE_PATH, "utf-8");

/** The exact seven paths the derived image must not ship. */
const HYGIENE_PATHS = [
  "/etc/ssh/ssh_host_rsa_key",
  "/etc/ssh/ssh_host_rsa_key.pub",
  "/etc/ssh/ssh_host_ecdsa_key",
  "/etc/ssh/ssh_host_ecdsa_key.pub",
  "/etc/ssh/ssh_host_ed25519_key",
  "/etc/ssh/ssh_host_ed25519_key.pub",
  "/root/.ssh/authorized_keys",
];

/**
 * Reconstruct the Dockerfile's logical instruction lines: drop comment lines
 * FIRST (an explanatory comment must never be able to satisfy the assertions
 * below on its own), then join line continuations so a multi-line `RUN` reads
 * as one searchable string.
 */
function extractLogicalInstructions(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The single instruction that performs the ssh hygiene removal, or null. */
function findHygieneInstruction(source: string): string | null {
  const candidates = extractLogicalInstructions(source).filter(
    (line) =>
      line.includes("rm ") &&
      /ssh_host_/.test(line) &&
      /_key/.test(line) &&
      line.includes("/root/.ssh/authorized_keys"),
  );
  return candidates.length === 1 ? (candidates[0] as string) : null;
}

/** Drop the hygiene `RUN` instruction, keeping every comment line intact. */
function withoutHygieneInstruction(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("RUN rm -f /etc/ssh/ssh_host_rsa_key"))
    .join("\n");
}

const hygiene = findHygieneInstruction(dockerfile);

describe("oci image hygiene", () => {
  it("removes the inherited ssh host keys and root authorized_keys in one fail-closed instruction", () => {
    assert.ok(
      hygiene !== null,
      "oci-container/Dockerfile must contain exactly one non-comment instruction that `rm`s " +
        "the ssh host keys together with /root/.ssh/authorized_keys; " +
        "dropping the removal step (or splitting it across instructions) fails this assertion",
    );

    const line = hygiene as string;

    // All three key types are named, together with their public halves.
    assert.match(line, /ssh_host_rsa_key/);
    assert.match(line, /ssh_host_ecdsa_key/);
    assert.match(line, /ssh_host_ed25519_key/);

    // Every one of the seven paths is removed by this same instruction: an
    // over-broad or partial removal is not enough.
    for (const path of HYGIENE_PATHS) {
      assert.ok(line.includes(path), `the hygiene instruction must name ${path}`);
    }

    // Exactly the file inside /root/.ssh is removed — never the directory
    // itself, which is legitimate and must survive.
    assert.match(line, /rm\s/);
    assert.ok(
      !/rm\s[^\n]*\s\/root\/\.ssh\s/.test(line),
      "the hygiene instruction must remove /root/.ssh/authorized_keys, not /root/.ssh itself",
    );

    // The removal is fail-closed in the SAME layer: the build must die if any
    // of the seven paths survives.
    assert.match(
      line,
      /test\s+!\s+-e/,
      "the hygiene instruction must positively assert the absence of each removed path",
    );
  });

  it("never regenerates host keys at build time", () => {
    assert.ok(
      !dockerfile.includes("ssh-keygen"),
      "oci-container/Dockerfile must not call ssh-keygen: keys are generated at first boot " +
        "by whoever wants them, never baked at build time",
    );
  });

  it("the matcher is not satisfiable by the explanatory comment alone", () => {
    // Fixture: the real Dockerfile minus the hygiene instruction, with every
    // comment line retained. The comment block explains the why but performs
    // no removal, so it must not satisfy findHygieneInstruction.
    assert.equal(
      findHygieneInstruction(withoutHygieneInstruction(dockerfile)),
      null,
      "the explanatory comment alone must not satisfy the hygiene assertion",
    );

    // Guard the fixture itself: it must still carry the comment and must have
    // actually dropped an instruction.
    assert.notEqual(withoutHygieneInstruction(dockerfile), dockerfile);
  });
});