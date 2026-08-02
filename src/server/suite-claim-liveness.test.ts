import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import {
  createControlServer,
  probeSuiteOwnerPid,
  type ControlServerOptions,
  type SuiteOwnerLiveness,
} from "../../dist/server/control-server.js";
import { CLAIM_TIMEOUT_MS } from "../../dist/suite/config.js";

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

describe("suite claim owner liveness", { concurrency: 1 }, () => {
  let now = 1_000_000;
  const deadPids = new Set<number>();
  const indeterminatePids = new Set<number>();
  const probedPids: number[] = [];
  const events: Array<Parameters<NonNullable<ControlServerOptions["emitSuiteClaimEvent"]>>[0]> = [];
  const secret = "suite-claim-liveness-secret";
  const server = createControlServer({
    listen: false,
    secret,
    now: () => now,
    probeSuiteOwnerPid: (pid): SuiteOwnerLiveness => {
      probedPids.push(pid);
      if (deadPids.has(pid)) return "dead";
      if (indeterminatePids.has(pid)) return "indeterminate";
      return "alive";
    },
    emitSuiteClaimEvent: (event) => events.push(event),
  });
  let port = 0;

  before(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  async function post(path: string, body: Record<string, unknown>): Promise<JsonResponse> {
    const payload = JSON.stringify(body);
    return await new Promise<JsonResponse>((resolve, reject) => {
      const req = http.request({
        method: "POST",
        hostname: "127.0.0.1",
        port,
        path,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(payload)),
          "x-tamandua-secret": secret,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
        }));
      });
      req.once("error", reject);
      req.end(payload);
    });
  }

  const request = (body: Record<string, unknown>): Promise<JsonResponse> => post("/suite/claim", body);

  function key(suffix: string, owner: string, pid: number | null = 101): Record<string, unknown> {
    return {
      origin_repo: `/repo/${suffix}`,
      tree_hash: `tree-${suffix}`,
      cmd_hash: `cmd-${suffix}`,
      owner_token: owner,
      ...(pid === null ? {} : { owner_pid: pid }),
      run_id: `run-${owner}`,
      step_id: `step-${owner}`,
    };
  }

  it("classifies only ESRCH as dead", () => {
    assert.equal(probeSuiteOwnerPid(1, () => true), "alive");
    assert.equal(probeSuiteOwnerPid(2, () => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }), "dead");
    for (const error of [
      Object.assign(new Error("denied"), { code: "EPERM" }),
      new Error("unknown"),
    ]) {
      assert.equal(probeSuiteOwnerPid(3, () => { throw error; }), "indeterminate");
    }
  });

  it("reclaims a provably dead owner once and grants exactly one concurrent waiter", async () => {
    const original = key("dead", "original");
    assert.equal((await request(original)).body.action, "run");
    deadPids.add(101);

    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) => request(key("dead", `waiter-${index}`, 200 + index))),
    );
    assert.equal(responses.filter((response) => response.body.action === "run").length, 1);
    assert.equal(responses.filter((response) => response.body.action === "wait").length, 7);

    const reclaimEvents = events.filter((event) => event.event === "suite.claim_dead_owner_reclaimed");
    assert.equal(reclaimEvents.length, 1);
    assert.equal(reclaimEvents[0].originRepo, original.origin_repo);
    assert.equal(reclaimEvents[0].ownerRunId, "run-original");
    assert.equal(reclaimEvents[0].ownerStepId, "step-original");
    assert.match(reclaimEvents[0].reclaimerRunId ?? "", /^run-waiter-/);
    assert.match(reclaimEvents[0].reclaimerStepId ?? "", /^step-waiter-/);
  });

  it("retains live, indeterminate, and legacy owners below the ceiling", async () => {
    indeterminatePids.add(302);
    for (const [suffix, pid] of [
      ["alive", 301],
      ["indeterminate", 302],
      ["legacy", null],
    ] as const) {
      const original = key(suffix, `${suffix}-owner`, pid);
      assert.equal((await request(original)).body.action, "run");
      assert.equal((await request(key(suffix, `${suffix}-waiter`, 400))).body.action, "wait");
    }
    const malformed = { ...key("malformed", "malformed-owner", null), owner_pid: "not-a-pid" };
    assert.equal((await request(malformed)).body.action, "run");
    assert.equal((await request(key("malformed", "malformed-waiter", 401))).body.action, "wait");
    assert.equal(events.filter((event) => event.event === "suite.claim_dead_owner_reclaimed").length, 1);
  });

  it("sweeps dead owners early, retains uncertain owners, and keeps ceiling expiration", async () => {
    deadPids.add(501);
    indeterminatePids.add(503);
    assert.equal((await request(key("sweep-dead", "dead-owner", 501))).body.action, "run");
    assert.equal((await request(key("sweep-live", "live-owner", 502))).body.action, "run");
    assert.equal((await request(key("sweep-unknown", "unknown-owner", 503))).body.action, "run");

    await request(key("sweep-trigger", "trigger", 504));
    assert.ok(
      probedPids.includes(501),
      "the ordinary sweep must probe and remove unrelated dead claims before the ceiling",
    );
    assert.equal(
      events.some((event) => event.event === "suite.claim_dead_owner_reclaimed"
        && event.originRepo === "/repo/sweep-dead"
        && event.reclaimerRunId === "run-trigger"),
      false,
      "an unrelated request must not be attributed as the dead claim's reclaimer",
    );
    assert.equal((await request(key("sweep-dead", "dead-reclaimer", 505))).body.action, "run");
    const sweepEvent = events.find((event) => event.event === "suite.claim_dead_owner_reclaimed"
      && event.originRepo === "/repo/sweep-dead");
    assert.equal(sweepEvent?.reclaimerRunId, "run-dead-reclaimer");
    assert.equal(sweepEvent?.reclaimerStepId, "step-dead-reclaimer");
    assert.equal((await request(key("sweep-live", "live-waiter", 506))).body.action, "wait");
    assert.equal((await request(key("sweep-unknown", "unknown-waiter", 507))).body.action, "wait");

    const beforeCeilingEventCount = events.filter(
      (event) => event.event === "suite.claim_dead_owner_reclaimed",
    ).length;
    now += CLAIM_TIMEOUT_MS + 1;
    assert.equal((await request(key("sweep-live", "post-ceiling", 508))).body.action, "run");
    assert.equal(
      events.filter((event) => event.event === "suite.claim_dead_owner_reclaimed").length,
      beforeCeilingEventCount,
      "age-ceiling expiration must not emit the dead-owner event",
    );
  });

  it("releases claims by exact run and optional step ownership without touching unrelated claims", async () => {
    assert.equal((await request(key("release-a", "release-a", 601))).body.action, "run");
    assert.equal((await request(key("release-b", "release-b", 602))).body.action, "run");
    assert.equal((await request(key("release-c", "release-c", 603))).body.action, "run");

    const released = await post("/suite/release-owner", {
      run_id: "run-release-a",
      step_id: "step-release-a",
    });
    assert.equal(released.status, 200);
    assert.equal(released.body.released, 1);

    const releaseEvent = events.find((event) => event.event === "suite.claim_owner_released"
      && event.originRepo === "/repo/release-a");
    assert.ok(releaseEvent, "owner-scoped release must leave a mechanically attributable timeline event");
    assert.equal(releaseEvent.ownerRunId, "run-release-a");
    assert.equal(releaseEvent.ownerStepId, "step-release-a");
    assert.equal(releaseEvent.releaseReason, "owner_recovery");

    assert.equal((await request(key("release-a", "replacement", 604))).body.action, "run");
    assert.equal((await request(key("release-b", "waiter-b", 605))).body.action, "wait");
    assert.equal((await request(key("release-c", "waiter-c", 606))).body.action, "wait");
  });

  it("emits claim-granted and claim-wait events for ordinary one-owner/N-waiter contention", async () => {
    const owner = key("ordinary", "ordinary-owner", 701);
    assert.equal((await request(owner)).body.action, "run");
    const waiters = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      request(key("ordinary", `ordinary-waiter-${index}`, 710 + index))));
    assert.deepEqual(waiters.map((response) => response.body.action), ["wait", "wait", "wait"]);

    const ordinaryEvents = events.filter((event) => event.originRepo === "/repo/ordinary");
    assert.equal(ordinaryEvents.filter((event) => event.event === "suite.claim_granted").length, 1);
    assert.equal(ordinaryEvents.filter((event) => event.event === "suite.claim_wait").length, 3);
    assert.deepEqual(
      ordinaryEvents.filter((event) => event.event === "suite.claim_wait").map((event) => event.ownerRunId),
      ["run-ordinary-owner", "run-ordinary-owner", "run-ordinary-owner"],
    );
  });
});
