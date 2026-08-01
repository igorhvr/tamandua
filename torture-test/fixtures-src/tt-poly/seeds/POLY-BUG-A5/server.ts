import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { InMemoryStore } from './store.js';
import type { Expense, Category } from './types.js';

const CATEGORIES: readonly Category[] = ['Food', 'Transport', 'Utilities', 'Entertainment', 'Other'];

function isCategory(value: unknown): value is Category {
  return typeof value === 'string' && CATEGORIES.includes(value as Category);
}

function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message });
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function getContentType(filePath: string): string {
  for (const [ext, contentType] of Object.entries(CONTENT_TYPES)) {
    if (filePath.endsWith(ext)) return contentType;
  }
  return 'application/octet-stream';
}

function serveStatic(pubDir: string, pathname: string, res: ServerResponse): boolean {
  // Map / to index.html
  let filePath: string;
  if (pathname === '/') {
    filePath = join(pubDir, 'index.html');
  } else {
    // Only serve .css and .js files from root
    if (!pathname.endsWith('.css') && !pathname.endsWith('.js')) return false;
    // Simple path traversal guard: reject paths with ..
    if (pathname.includes('..')) return false;
    filePath = join(pubDir, pathname);
    // Ensure resolved path is within pubDir
    const resolved = resolve(filePath);
    const resolvedPub = resolve(pubDir);
    if (!resolved.startsWith(resolvedPub)) return false;
  }

  if (!existsSync(filePath)) return false;

  const content = readFileSync(filePath, 'utf-8');
  res.writeHead(200, { 'Content-Type': getContentType(filePath), 'Content-Length': String(Buffer.byteLength(content)) });
  res.end(content);
  return true;
}

function getSingleId(pathname: string): string | null {
  const prefix = '/api/expenses/';
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length);
  return id.length > 0 ? id : null;
}

// ── Cross-language integration bridge (POLY-BUG-A5) ───────────────
// Test-only bridge that mirrors the Python lookup_calendar_name() contract.
// POLY-BUG-A5: keys simultaneously changed to calendarName/calendarId in
// both python/src/schedlib/integrations.py AND this bridge.
export function lookupCalendarName(calendarId: number): { calendarName: string; calendarId: number } {
  // POLY-BUG-A5: keys renamed to calendarName/calendarId in both subtrees.
  // The keys must match the Python side exactly — this is the cross-language
  // coupling that A5 exploits.
  return { calendarName: `Calendar-${calendarId}`, calendarId: calendarId };
}

export function startServer(port: number) {
  const store = new InMemoryStore();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const { pathname } = url;

    // POST /api/expenses — create expense
    if (req.method === 'POST' && pathname === '/api/expenses') {
      let body: unknown;
      try {
        body = await parseBody(req);
      } catch {
        sendError(res, 400, 'Invalid JSON body');
        return;
      }

      if (typeof body !== 'object' || body === null) {
        sendError(res, 400, 'Request body must be a JSON object');
        return;
      }

      const { description, amount, category } = body as Record<string, unknown>;

      if (typeof description !== 'string' || description.trim().length === 0) {
        sendError(res, 400, 'Missing required field: description');
        return;
      }

      if (typeof amount !== 'number' || isNaN(amount)) {
        sendError(res, 400, 'Missing required field: amount');
        return;
      }

      if (!isCategory(category)) {
        sendError(res, 400, 'Missing or invalid field: category');
        return;
      }

      const expense: Expense = {
        id: randomUUID(),
        description: description.trim(),
        amount,
        category,
        date: new Date().toISOString().split('T')[0],
      };

      store.add(expense);
      sendJson(res, 201, expense);
      return;
    }

    // GET /api/expenses — list all, optional ?category=
    if (req.method === 'GET' && pathname === '/api/expenses') {
      const categoryParam = url.searchParams.get('category');
      let expenses: Expense[];
      if (categoryParam && isCategory(categoryParam)) {
        expenses = store.getByCategory(categoryParam);
      } else if (categoryParam) {
        // Invalid category filter — return empty
        expenses = [];
      } else {
        expenses = store.getAll();
      }
      sendJson(res, 200, expenses);
      return;
    }

    // GET /api/expenses/:id — get single expense
    const singleId = getSingleId(pathname);
    if (req.method === 'GET' && singleId !== null) {
      const expense = store.getById(singleId);
      if (!expense) {
        sendError(res, 404, 'Expense not found');
        return;
      }
      sendJson(res, 200, expense);
      return;
    }

    // PUT /api/expenses/:id — update expense
    if (req.method === 'PUT' && singleId !== null) {
      const expense = store.getById(singleId);
      if (!expense) {
        sendError(res, 404, 'Expense not found');
        return;
      }

      let body: unknown;
      try {
        body = await parseBody(req);
      } catch {
        sendError(res, 400, 'Invalid JSON body');
        return;
      }

      if (typeof body !== 'object' || body === null) {
        sendError(res, 400, 'Request body must be a JSON object');
        return;
      }

      // VULN-T2: Object.assign with unsanitized user input — dormant in green baseline
      const updates = Object.assign({}, body as Record<string, unknown>);

      // Validate optional fields if provided
      if ('description' in updates && (typeof updates.description !== 'string' || (updates.description as string).trim().length === 0)) {
        sendError(res, 400, 'Invalid field: description must be a non-empty string');
        return;
      }

      if ('amount' in updates && (typeof updates.amount !== 'number' || isNaN(updates.amount as number))) {
        sendError(res, 400, 'Invalid field: amount must be a number');
        return;
      }

      if ('category' in updates && !isCategory(updates.category)) {
        sendError(res, 400, 'Invalid field: category must be a valid category');
        return;
      }

      const updated = store.update(singleId, updates as Record<string, unknown>);
      sendJson(res, 200, updated);
      return;
    }

    // DELETE /api/expenses/:id — delete expense
    if (req.method === 'DELETE' && singleId !== null) {
      const deleted = store.delete(singleId);
      if (!deleted) {
        sendError(res, 404, 'Expense not found');
        return;
      }
      res.writeHead(204);
      res.end();
      return;
    }

    // Static file serving from public/ directory
    if (req.method === 'GET') {
      const pubDir = resolve(import.meta.dirname ?? '.', '..', 'public');
      if (serveStatic(pubDir, pathname, res)) return;
    }

    // 404 for all unmatched routes
    sendError(res, 404, 'Not found');
  });

  return new Promise<{ server: ReturnType<typeof createServer>; close: () => Promise<void> }>((resolve) => {
    server.listen(port, () => {
      resolve({
        server,
        close: () => new Promise<void>((resolveClose, rejectClose) => {
          server.close((err) => {
            if (err) rejectClose(err);
            else resolveClose();
          });
        }),
      });
    });
  });
}
