// Tier-2 STORM-REHEARSAL US-003 (S7) — MCP read-path pounding transport.
//
// Attempt-2 finding S7: the MCP pounding probes parsed the streamable-HTTP
// response with .json(), but the product endpoint answers SSE (`event:
// message` + `data: <json-rpc>`) — every mcp_tool probe failed with
// "Unexpected token 'e'" (Round A 220/330, Round B 582/873) while dashboard
// HTTP probes were fine and latency was far under bound. This file is the
// focused self-test for the fixed transport:
//
//   P1  a genuine SSE tools/call result yields ok:true (result present,
//       isError !== true) and the tools/call carries the captured session id;
//   P2  an application/json response is parsed identically (both transports);
//   P3  a JSON-RPC error yields ok:false carrying the error text;
//   P4  a result with isError:true yields ok:false (never a fabricated ok);
//   P5  a malformed SSE data frame yields ok:false;
//   P6  an SSE body with no JSON-RPC message matching the request id fails;
//   P7  initialize requires HTTP 2xx AND a session id (header or
//       result.sessionId);
//   P8  the pure parse/select helpers behave frame-by-frame;
//   P9  pounding uses the product's REAL registered tool names
//       (src/server/mcp-server.ts) — asserted mechanically against the source.
//
// The stand-in server binds an OS-allocated port on 127.0.0.1 (never the
// production 3334/3338/3339) and lives entirely in this process. No daemon,
// harness or workflow is spawned.

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import {
  makeRealMcpTool,
  parseMcpStreamableResponseBody,
  selectJsonRpcMessage,
} from "../bin/tt-storm-real.mjs";
import {
  REHEARSAL_MCP_TOOL_ARGS,
  REHEARSAL_MCP_TOOLS,
} from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();

// Scenario for the stand-in tools/call handler.
type Scenario =
  | "genuine"
  | "json"
  | "rpcError"
  | "isError"
  | "malformed"
  | "wrongId"
  | "emptyData"
  | "call500";

let server: http.Server;
let port = 0;
let scenario: Scenario = "genuine";
let initScenario: "ok" | "okNoSession" | "http500" | "rpcError" | "malformed" = "ok";
let toolsCallCount = 0;
let lastToolsCallArgs: unknown = null;
let lastSessionId: string | null = null;
let lastInitBody: any = null;

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : null);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function writeSse(
  res: http.ServerResponse,
  frames: Array<{ event?: string; data: unknown }>,
  { sessionId }: { sessionId?: string | null } = {},
): void {
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  res.writeHead(200, headers);
  for (const frame of frames) {
    res.write(`event: ${frame.event ?? "message"}\n`);
    const payload = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
    res.write(`data: ${payload}\n\n`);
  }
  res.end();
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

before(async () => {
  server = http.createServer(async (req, res) => {
    if (req.method !== "POST") {
      writeJson(res, 405, { error: "method not allowed" });
      return;
    }
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch {
      writeJson(res, 400, { error: "bad json" });
      return;
    }
    if (body?.method === "initialize") {
      lastInitBody = body;
      if (initScenario === "http500") {
        writeJson(res, 500, { error: "boom" });
        return;
      }
      if (initScenario === "rpcError") {
        writeSse(res, [{ data: { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "init refused" } } }]);
        return;
      }
      if (initScenario === "malformed") {
        writeSse(res, [{ data: "{not-json" }]);
        return;
      }
      const result: Record<string, unknown> = {
        protocolVersion: "2025-03-26",
        capabilities: {},
        serverInfo: { name: "tt-storm-mcp-standin", version: "0.0.0" },
      };
      if (initScenario === "okNoSession") {
        writeSse(res, [{ data: { jsonrpc: "2.0", id: body.id, result } }]);
        return;
      }
      writeSse(res, [{ data: { jsonrpc: "2.0", id: body.id, result } }], { sessionId: "sess-standin-1" });
      return;
    }
    if (body?.method === "tools/call") {
      toolsCallCount += 1;
      lastToolsCallArgs = body?.params?.arguments ?? null;
      lastSessionId = (req.headers["mcp-session-id"] as string | undefined) ?? null;
      const id = body?.id ?? 2;
      switch (scenario) {
        case "json":
          writeJson(res, 200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "json-ok" }] } });
          return;
        case "rpcError":
          writeSse(res, [{ data: { jsonrpc: "2.0", id, error: { code: -32602, message: "invalid args for tool" } } }]);
          return;
        case "isError":
          writeSse(res, [{ data: { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: "tool blew up" }] } } }]);
          return;
        case "malformed":
          writeSse(res, [{ data: "{definitely not json" }]);
          return;
        case "wrongId":
          writeSse(res, [{ data: { jsonrpc: "2.0", id: 99, result: { content: [] } } }]);
          return;
        case "emptyData":
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(": keepalive\n\n");
          res.end();
          return;
        case "call500":
          writeJson(res, 500, { error: "call failed" });
          return;
        case "genuine":
        default:
          writeSse(res, [{ data: { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "genuine-ok" }] } } }]);
          return;
      }
    }
    writeJson(res, 404, { error: `unknown method ${body?.method}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "stand-in MCP server must bind a port");
  port = address.port;
  assert.ok(![3334, 3338, 3339].includes(port), "stand-in never binds a production port");
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  scenario = "genuine";
  initScenario = "ok";
  toolsCallCount = 0;
  lastToolsCallArgs = null;
  lastSessionId = null;
  lastInitBody = null;
});

function tool() {
  return makeRealMcpTool({ endpointUrl: `http://127.0.0.1:${port}/mcp`, timeoutMs: 2_000 });
}

describe("US-003 MCP streamable-HTTP pounding transport (S7)", () => {
  it("P1: a genuine SSE tools/call result yields ok:true with the captured session id", async () => {
    const res = await tool()({ tool: "tamandua.runs.list", args: { limit: 5 } });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.statusCode, 200);
    assert.ok(typeof res.latencyMs === "number" && res.latencyMs >= 0, "latency is measured");
    assert.equal(res.error, null);
    assert.ok(res.result && typeof res.result === "object", "a genuine result is returned");
    assert.equal(toolsCallCount, 1, "exactly one tools/call");
    assert.deepEqual(lastToolsCallArgs, { limit: 5 }, "the tool arguments are forwarded");
    assert.equal(lastSessionId, "sess-standin-1", "tools/call carries the initialize session id");
    assert.equal(lastInitBody?.params?.protocolVersion, "2025-03-26");
  });

  it("P2: an application/json response parses identically (both transports)", async () => {
    scenario = "json";
    const res = await tool()({ tool: "tamandua.runs.list" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.statusCode, 200);
    assert.equal(res.result?.content?.[0]?.text, "json-ok");
  });

  it("P3: a JSON-RPC error yields ok:false carrying the error text", async () => {
    scenario = "rpcError";
    const res = await tool()({ tool: "tamandua.run.status", args: { query: "run-x" } });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(String(res.error), /invalid args for tool/, "the RPC error text is surfaced");
    assert.equal(res.result, null);
  });

  it("P4: a result with isError:true yields ok:false (no fabricated success)", async () => {
    scenario = "isError";
    const res = await tool()({ tool: "tamandua.run.status", args: { query: "run-x" } });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(String(res.error), /isError:true/);
    assert.match(String(res.error), /tool blew up/);
    assert.ok(res.result, "the isError result is still returned for evidence");
  });

  it("P5: a malformed SSE data frame yields ok:false", async () => {
    scenario = "malformed";
    const res = await tool()({ tool: "tamandua.runs.list" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(String(res.error), /unparseable/);
    assert.match(String(res.error), /malformed SSE/);
  });

  it("P6: an SSE body with no JSON-RPC message matching the request id fails", async () => {
    scenario = "wrongId";
    const res = await tool()({ tool: "tamandua.runs.list" });
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(String(res.error), /no JSON-RPC message with id 2/);

    scenario = "emptyData";
    const res2 = await tool()({ tool: "tamandua.runs.list" });
    assert.equal(res2.ok, false, JSON.stringify(res2));
    assert.match(String(res2.error), /no data: JSON-RPC payload/);

    scenario = "call500";
    const res3 = await tool()({ tool: "tamandua.runs.list" });
    assert.equal(res3.ok, false, JSON.stringify(res3));
    assert.match(String(res3.error), /HTTP 500/);
  });

  it("P7: initialize requires HTTP 2xx and a session id", async () => {
    scenario = "genuine";
    initScenario = "http500";
    const r500 = await tool()({ tool: "tamandua.runs.list" });
    assert.equal(r500.ok, false);
    assert.match(String(r500.error), /MCP initialize HTTP 500/);
    assert.equal(toolsCallCount, 0, "no tools/call after a failed initialize");

    initScenario = "okNoSession";
    const rNoSess = await tool()({ tool: "tamandua.runs.list" });
    assert.equal(rNoSess.ok, false, JSON.stringify(rNoSess));
    assert.match(String(rNoSess.error), /no mcp-session-id header or result\.sessionId/);
    assert.equal(toolsCallCount, 0, "no tools/call without a session");

    initScenario = "rpcError";
    const rInitErr = await tool()({ tool: "tamandua.runs.list" });
    assert.equal(rInitErr.ok, false);
    assert.match(String(rInitErr.error), /MCP initialize RPC error/);
  });

  it("P8: pure parse/select helpers decode JSON + multi-frame SSE and reject garbage", () => {
    const json = parseMcpStreamableResponseBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', "application/json");
    assert.equal(json.ok, true);
    assert.equal(json.transport, "json");
    assert.equal(selectJsonRpcMessage(json.messages, 1).result.ok, true);
    assert.equal(selectJsonRpcMessage(json.messages, 7), null);

    const multi = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":0,"result":{}}',
      "",
      ": keepalive",
      "event: message",
      'data: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}',
      "",
    ].join("\n");
    const sse = parseMcpStreamableResponseBody(multi, "text/event-stream; charset=utf-8");
    assert.equal(sse.ok, true);
    assert.equal(sse.transport, "sse");
    assert.equal(sse.messages.length, 2);
    assert.equal(selectJsonRpcMessage(sse.messages, 2).result.content.length, 0);

    // Multi-line data: payload is joined with newlines before JSON.parse.
    const multiLine = 'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":3,"result":{"a":1}}\n\n';
    const ml = parseMcpStreamableResponseBody(multiLine);
    assert.equal(ml.ok, true);
    assert.equal(selectJsonRpcMessage(ml.messages, 3).result.a, 1);

    // A body that merely LOOKS like SSE but has a broken frame fails.
    const broken = parseMcpStreamableResponseBody("event: message\ndata: nope\n\n");
    assert.equal(broken.ok, false);
    assert.match(String(broken.error), /malformed SSE/);

    // Empty and non-JSON bodies fail rather than fabricate.
    assert.equal(parseMcpStreamableResponseBody("", "text/event-stream").ok, false);
    assert.equal(parseMcpStreamableResponseBody("hello", "application/json").ok, false);
  });

  it("P9: pounding uses the product's real registered MCP tool names", () => {
    assert.deepEqual(
      [...REHEARSAL_MCP_TOOLS],
      ["tamandua.runs.list", "tamandua.run.status"],
      "the pounded tool names are the product's registered names",
    );
    const source = fs.readFileSync(path.join(repoRoot, "src", "server", "mcp-server.ts"), "utf8");
    for (const name of REHEARSAL_MCP_TOOLS) {
      assert.ok(
        source.includes(`"${name}"`),
        `registered product tool name ${name} must appear verbatim in src/server/mcp-server.ts`,
      );
    }
    assert.deepEqual(REHEARSAL_MCP_TOOL_ARGS["tamandua.runs.list"], { limit: 10 });
    // No legacy short names survive anywhere in the pounded set.
    for (const legacy of ["runs.list", "run.status"]) {
      assert.ok(!REHEARSAL_MCP_TOOLS.includes(legacy), `legacy unregistered name ${legacy} must not be pounded`);
    }
  });
});
