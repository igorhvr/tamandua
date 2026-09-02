import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createTempHome } from "../../tests/helpers/test-env.ts";
import { createDashboardServer } from "../../dist/server/dashboard.js";

async function startDashboard(): Promise<{ server: http.Server; baseUrl: string }> {
  const server = createDashboardServer(0);
  if (!server.listening) {
    await once(server, "listening");
  }

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopDashboard(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Point HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH at a per-test temp
 * directory (createTempHome) so the dashboard server's getDb()/logger/events
 * resolve into temp state instead of the operator's real ~/.tamandua (the
 * test-isolation guard would otherwise throw and the caller would skip the
 * write, hiding coverage). Returns the temp stateDir/dbPath plus a restore
 * function; call restore() in the afterEach hook.
 */
function isolateDashboardState(prefix: string): { stateDir: string; dbPath: string; restore: () => void } {
  const { root, homeDir } = createTempHome(prefix);
  const stateDir = path.join(root, "state");
  const dbPath = path.join(stateDir, "tamandua.db");
  const previousHome = process.env.HOME;
  const previousStateDir = process.env.TAMANDUA_STATE_DIR;
  const previousDbPath = process.env.TAMANDUA_DB_PATH;
  process.env.HOME = homeDir;
  process.env.TAMANDUA_STATE_DIR = stateDir;
  process.env.TAMANDUA_DB_PATH = dbPath;
  return {
    stateDir,
    dbPath,
    restore: () => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
      else process.env.TAMANDUA_STATE_DIR = previousStateDir;
      if (previousDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
      else process.env.TAMANDUA_DB_PATH = previousDbPath;
    },
  };
}

describe("kanban poll toggle HTML", () => {
  let isolate: ReturnType<typeof isolateDashboardState> | undefined;
  let dbPath: string;

  beforeEach(() => {
    isolate = isolateDashboardState("tamandua-kanban-html-");
    dbPath = isolate.dbPath;
  });

  afterEach(() => {
    isolate?.restore();
    isolate = undefined;
  });

  it("contains poll toggle checkbox with default checked state", async () => {
    const { server, baseUrl } = await startDashboard();
    assert.ok(fs.existsSync(dbPath), "dashboard server must open the temp DB (previously skipped)");

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Checkbox element exists with id poll-toggle
      assert.match(html, /id="poll-toggle"/);
      // Checkbox is checked by default
      assert.match(html, /<input[^>]*type="checkbox"[^>]*checked/);
      // Checkbox is inside footer-right
      const footerRightStart = html.indexOf('id="footer-right"');
      const pollToggleStart = html.indexOf('id="poll-toggle"');
      assert.ok(pollToggleStart > footerRightStart, "poll toggle not inside footer-right");
    } finally {
      await stopDashboard(server);
    }
  });

  it("contains poll label span inside footer-right", async () => {
    const { server, baseUrl } = await startDashboard();
    assert.ok(fs.existsSync(dbPath), "dashboard server must open the temp DB (previously skipped)");

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Poll label span exists
      assert.match(html, /id="poll-label"/);
      // Default text is "poll 3s"
      assert.match(html, /poll 3s/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("contains setInterval/clearInterval toggle logic", async () => {
    const { server, baseUrl } = await startDashboard();
    assert.ok(fs.existsSync(dbPath), "dashboard server must open the temp DB (previously skipped)");

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // startPolling function exists and calls setInterval
      assert.match(html, /function startPolling/);
      assert.match(html, /pollInterval = setInterval\(tick, REFRESH_MS\)/);
      // stopPolling function exists and calls clearInterval
      assert.match(html, /function stopPolling/);
      assert.match(html, /clearInterval\(pollInterval\)/);
      // updatePollLabel function exists
      assert.match(html, /function updatePollLabel/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("REFRESH_MS constant is unchanged at 3000", async () => {
    const { server, baseUrl } = await startDashboard();
    assert.ok(fs.existsSync(dbPath), "dashboard server must open the temp DB (previously skipped)");

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /const REFRESH_MS = 3000;/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("checkbox change event listener calls startPolling and stopPolling", async () => {
    const { server, baseUrl } = await startDashboard();
    assert.ok(fs.existsSync(dbPath), "dashboard server must open the temp DB (previously skipped)");

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // Event listener for checkbox change
      assert.match(html, /addEventListener\("change"/);
      // startPolling called when checked
      assert.match(html, /if \(chk\.checked\)/);
      assert.match(html, /startPolling\(\)/);
      // stopPolling called when unchecked
      assert.match(html, /stopPolling\(\)/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("footer-right contains poll toggle label structure", async () => {
    const { server, baseUrl } = await startDashboard();
    assert.ok(fs.existsSync(dbPath), "dashboard server must open the temp DB (previously skipped)");

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // footer-right span exists
      assert.match(html, /id="footer-right"/);
      // Contains a label element wrapping the checkbox and text
      assert.match(html, /<label>/);
      // The poll label and checkbox are inside the same footer-right area
      const footerRightStart = html.indexOf('id="footer-right"');
      const footerRightEnd = html.indexOf("</footer>", footerRightStart);
      const footerRightContent = html.slice(footerRightStart, footerRightEnd);

      assert.match(footerRightContent, /id="poll-toggle"/);
      assert.match(footerRightContent, /id="poll-label"/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("poll label text updates for paused state", async () => {
    const { server, baseUrl } = await startDashboard();
    assert.ok(fs.existsSync(dbPath), "dashboard server must open the temp DB (previously skipped)");

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // updatePollLabel sets "poll paused" when unchecked
      assert.match(html, /"poll paused"/);
      // and "poll " + seconds when checked
      assert.match(html, /"poll " \+ \(REFRESH_MS \/ 1000\) \+ "s"/);
    } finally {
      await stopDashboard(server);
    }
  });
});
