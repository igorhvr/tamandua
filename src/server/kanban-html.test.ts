import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
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

describe("kanban page HTML (React SPA)", () => {
  it("serves React SPA for kanban route", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      // React SPA root div
      assert.match(html, /<div id="root"><\/div>/);
      // Script tag for the built JS
      assert.match(html, /<script type="module" crossorigin src="\/assets\/index-/);
      // Title
      assert.match(html, /<title>Tamandua<\/title>/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("kanban page includes Inter and JetBrains Mono font links", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /Inter:wght@400;500;600;700/);
      assert.match(html, /JetBrains\+Mono:wght@400;500;600/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("kanban page has viewport meta tag for mobile", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /name="viewport"/);
      assert.match(html, /content="width=device-width, initial-scale=1\.0"/);
    } finally {
      await stopDashboard(server);
    }
  });

  it("kanban page has charset meta tag", async () => {
    const { server, baseUrl } = await startDashboard();

    try {
      const response = await fetch(`${baseUrl}/runs/test-run-id/kanban`);
      assert.equal(response.status, 200);

      const html = await response.text();

      assert.match(html, /charset="UTF-8"/);
    } finally {
      await stopDashboard(server);
    }
  });
});
