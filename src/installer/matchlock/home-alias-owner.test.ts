/**
 * home-alias-owner.test.ts — unit coverage for the host-side owner identity +
 * kernel-proven liveness protocol of the keyed Matchlock short-HOME alias
 * (US-002). Pure/injectable + a real temp filesystem for the resolver; no VM,
 * no daemon, no spawning (the process-start-identity import is driven through
 * injected probes).
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import {
  MATCHLOCK_HOME_ALIAS_OWNER_SCHEMA,
  MatchlockHomeAliasError,
  matchlockHomeAliasKey,
  matchlockHomeAliasOwnerPath,
  type MatchlockHomeAliasOwnerRecord,
} from "../../../dist/installer/matchlock/home-alias.js";
import {
  classifyMatchlockAliasOwner,
  daemonOwnerIdentity,
  defaultProcessExists,
  describeMatchlockHomeAliasWithOwner,
  ownerIsLive,
  resolveMatchlockHomeAliasWithOwner,
} from "../../../dist/installer/matchlock/home-alias-owner.js";

const OWNER: MatchlockHomeAliasOwnerRecord = {
  schema: MATCHLOCK_HOME_ALIAS_OWNER_SCHEMA,
  pid: 7777,
  startIdentity: "v2:7777:1600000000000",
  realHome: "/home/owner",
  aliasPath: "/home/owner/alias-h",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function isOwnerRefusal(err: unknown, reason: string): boolean {
  return err instanceof MatchlockHomeAliasError && err.reason === reason;
}

describe("daemonOwnerIdentity", () => {
  it("returns the kernel v2 identity of a pid", () => {
    const id = daemonOwnerIdentity(321, {
      getProcessStartIdentity: (pid) => `v2:${pid}:1700000000000`,
    });
    assert.deepEqual(id, { pid: 321, startIdentity: "v2:321:1700000000000" });
  });

  it("refuses with alias_owner_unreadable when no comparable identity exists", () => {
    assert.throws(
      () => daemonOwnerIdentity(321, { getProcessStartIdentity: () => null }),
      (err: unknown) => isOwnerRefusal(err, "alias_owner_unreadable"),
    );
    assert.throws(
      () => daemonOwnerIdentity(321, { getProcessStartIdentity: () => "v2u:321" }),
      (err: unknown) => isOwnerRefusal(err, "alias_owner_unreadable"),
    );
  });
});

describe("classifyMatchlockAliasOwner", () => {
  it("passes through the kernel start-identity comparison", () => {
    assert.equal(
      classifyMatchlockAliasOwner(OWNER, {
        getProcessStartIdentity: () => "v2:7777:1600000000000",
      }),
      "same",
    );
    assert.equal(
      classifyMatchlockAliasOwner(OWNER, {
        getProcessStartIdentity: () => "v2:7777:1500000000000",
      }),
      "different",
    );
  });

  it("treats an absent pid as stale (different) so a dead owner is reclaimable", () => {
    assert.equal(
      classifyMatchlockAliasOwner(OWNER, {
        getProcessStartIdentity: () => null,
        processExists: () => false,
      }),
      "different",
    );
  });

  it("fails closed (unknown) when the identity is unreadable but the pid still exists", () => {
    for (const actual of [null, "v2u:7777"]) {
      assert.equal(
        classifyMatchlockAliasOwner(OWNER, {
          getProcessStartIdentity: () => actual,
          processExists: () => true,
        }),
        "unknown",
        `actual ${String(actual)} with a live pid must be unknown`,
      );
    }
  });

  it("defaultProcessExists never signals and is true for this process", () => {
    assert.equal(defaultProcessExists(process.pid), true);
    assert.equal(defaultProcessExists(-1), false);
  });
});

describe("ownerIsLive", () => {
  it("is true only for a kernel-proven SAME live owner", () => {
    assert.equal(
      ownerIsLive(OWNER, { getProcessStartIdentity: () => "v2:7777:1600000000000" }),
      true,
    );
  });

  it("is false for a recycled pid (different) and for an unprovable owner (unknown)", () => {
    assert.equal(
      ownerIsLive(OWNER, { getProcessStartIdentity: () => "v2:7777:1500000000000" }),
      false,
    );
    assert.equal(
      ownerIsLive(OWNER, {
        getProcessStartIdentity: () => null,
        processExists: () => true,
      }),
      false,
      "unknown liveness must never be reported live",
    );
    assert.equal(
      ownerIsLive(OWNER, {
        getProcessStartIdentity: () => null,
        processExists: () => false,
      }),
      false,
      "an absent pid is stale, not live",
    );
  });
});

describe("owner-aware resolver", () => {
  const cleanups: string[] = [];
  afterEach(() => {
    for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the owner sidecar with this daemon's identity and returns the keyed alias HOME", () => {
    const root = tamanduaTempDir("tamandua-owner-resolver-");
    cleanups.push(root);
    const tmp = path.join(root, "tmp");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const deps = {
      env: { HOME: home },
      tmpdir: tmp,
      uid,
      realHome: home,
      ownerPid: 5555,
      ownerStartIdentity: "v2:5555:1700000000000",
    };

    const resolved = describeMatchlockHomeAliasWithOwner(deps);
    assert.equal(resolved.aliasKey, matchlockHomeAliasKey(home));
    assert.equal(resolved.home, path.join(tmp, "tamandua", String(uid), resolved.aliasKey!, "h"));

    const ownerPath = matchlockHomeAliasOwnerPath(resolved.aliasDir as string);
    const record = JSON.parse(fs.readFileSync(ownerPath, "utf8")) as MatchlockHomeAliasOwnerRecord;
    assert.equal(record.pid, 5555);
    assert.equal(record.startIdentity, "v2:5555:1700000000000");
    assert.equal(record.realHome, home);
    assert.equal(record.aliasPath, resolved.aliasPath);

    // Re-resolving from the same process reuses its own sidecar (no refusal).
    const second = resolveMatchlockHomeAliasWithOwner(deps);
    assert.equal(second, resolved.home);
  });

  it("refuses with alias_owner_unreadable when the daemon identity cannot be read", () => {
    assert.throws(
      () =>
        describeMatchlockHomeAliasWithOwner({
          env: { HOME: "/home/unused-owner-home" },
          ownerPid: 5555,
          ownerStartIdentity: null,
        }),
      (err: unknown) => isOwnerRefusal(err, "alias_owner_unreadable"),
    );
  });
});
