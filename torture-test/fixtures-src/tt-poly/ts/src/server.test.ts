import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { request } from 'node:http';
import { startServer } from './server.js';

interface TestServer {
  close: () => Promise<void>;
}

function httpRequest(method: string, port: number, path: string, body?: unknown | { raw: string }): Promise<{ status: number; data: unknown; headers: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let bodyStr: string | undefined;
    let isRaw = false;
    if (body !== undefined) {
      if (typeof body === 'object' && body !== null && 'raw' in body) {
        bodyStr = (body as { raw: string }).raw;
        isRaw = true;
      } else {
        bodyStr = JSON.stringify(body);
      }
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };
    if (bodyStr) {
      headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
    }

    const req = request(
      {
        hostname: 'localhost',
        port,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let data: unknown = null;
          if (raw.length > 0) {
            try {
              data = JSON.parse(raw);
            } catch {
              data = raw;
            }
          }
          const responseHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (v) responseHeaders[k] = Array.isArray(v) ? v[0] : v;
          }
          resolve({ status: res.statusCode ?? 0, data, headers: responseHeaders });
        });
      }
    );

    req.on('error', reject);

    if (bodyStr) {
      req.write(bodyStr);
    }
    req.end();
  });
}

describe('Server API', () => {
  let port: number;
  let server: TestServer;

  before(async () => {
    // Use a random high port
    const s = await startServer(0);
    server = s;
    // Get the actual port assigned
    const addr = (s as unknown as { server: { address: () => { port: number } | null } }).server?.address?.();
    port = addr && typeof addr === 'object' ? addr.port : 34567;
  });

  after(async () => {
    await server.close();
  });

  describe('POST /api/expenses', () => {
    it('creates an expense and returns 201 with the created object', async () => {
      const { status, data } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Groceries',
        amount: 45.50,
        category: 'Food',
      });

      assert.strictEqual(status, 201);
      const expense = data as Record<string, unknown>;
      assert.strictEqual(expense.description, 'Groceries');
      assert.strictEqual(expense.amount, 45.50);
      assert.strictEqual(expense.category, 'Food');
      assert.strictEqual(typeof expense.id, 'string');
      assert.ok((expense.id as string).length > 0);
      assert.strictEqual(typeof expense.date, 'string');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { status, data } = await httpRequest('POST', port, '/api/expenses', { raw: 'not json' });
      assert.strictEqual(status, 400);
      assert.strictEqual((data as Record<string, unknown>).error, 'Invalid JSON body');
    });

    it('returns 400 when description is missing', async () => {
      const { status, data } = await httpRequest('POST', port, '/api/expenses', {
        amount: 10,
        category: 'Food',
      });
      assert.strictEqual(status, 400);
      assert.ok(((data as Record<string, unknown>).error as string).includes('description'));
    });

    it('returns 400 when amount is missing', async () => {
      const { status, data } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Test',
        category: 'Food',
      });
      assert.strictEqual(status, 400);
      assert.ok(((data as Record<string, unknown>).error as string).includes('amount'));
    });

    it('returns 400 when category is invalid', async () => {
      const { status, data } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Test',
        amount: 10,
        category: 'InvalidCategory',
      });
      assert.strictEqual(status, 400);
      assert.ok(((data as Record<string, unknown>).error as string).includes('category'));
    });

    it('returns 400 when category is missing', async () => {
      const { status, data } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Test',
        amount: 10,
      });
      assert.strictEqual(status, 400);
      assert.ok(((data as Record<string, unknown>).error as string).includes('category'));
    });

    it('returns 400 for empty description string', async () => {
      const { status, data } = await httpRequest('POST', port, '/api/expenses', {
        description: '   ',
        amount: 10,
        category: 'Food',
      });
      assert.strictEqual(status, 400);
      assert.ok(((data as Record<string, unknown>).error as string).includes('description'));
    });

    it('returns 400 for non-object body', async () => {
      const { status } = await httpRequest('POST', port, '/api/expenses', 42);
      assert.strictEqual(status, 400);
    });
  });

  describe('GET /api/expenses', () => {
    it('returns all expenses as JSON array', async () => {
      // Create two expenses first
      const { data: exp1 } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Rent',
        amount: 1000,
        category: 'Utilities',
      });
      const { data: exp2 } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Lunch',
        amount: 15,
        category: 'Food',
      });

      const { status, data } = await httpRequest('GET', port, '/api/expenses');
      assert.strictEqual(status, 200);
      const expenses = data as Record<string, unknown>[];
      assert.ok(expenses.length >= 2);
      const ids = expenses.map((e: Record<string, unknown>) => e.id);
      assert.ok(ids.includes((exp1 as Record<string, unknown>).id));
      assert.ok(ids.includes((exp2 as Record<string, unknown>).id));
    });

    it('returns Content-Type application/json', async () => {
      const { headers } = await httpRequest('GET', port, '/api/expenses');
      assert.ok(headers['content-type']?.includes('application/json'));
    });

    it('filters by category when ?category= query param provided', async () => {
      await httpRequest('POST', port, '/api/expenses', {
        description: 'Bus ticket',
        amount: 3,
        category: 'Transport',
      });
      await httpRequest('POST', port, '/api/expenses', {
        description: 'Lunch',
        amount: 12,
        category: 'Food',
      });

      const { status, data } = await httpRequest('GET', port, '/api/expenses?category=Transport');
      assert.strictEqual(status, 200);
      const expenses = data as Record<string, unknown>[];
      assert.ok(expenses.length > 0);
      assert.ok(expenses.every((e: Record<string, unknown>) => e.category === 'Transport'));
    });

    it('returns empty array for category with no expenses', async () => {
      const { status, data } = await httpRequest('GET', port, '/api/expenses?category=Entertainment');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(data, []);
    });

    it('returns empty array for invalid category', async () => {
      const { status, data } = await httpRequest('GET', port, '/api/expenses?category=Invalid');
      assert.strictEqual(status, 200);
      assert.deepStrictEqual(data, []);
    });
  });

  describe('GET /api/expenses/:id', () => {
    it('returns a single expense by id', async () => {
      const { data: created } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Coffee',
        amount: 5,
        category: 'Food',
      });
      const createdExpense = created as Record<string, unknown>;

      const { status, data } = await httpRequest('GET', port, `/api/expenses/${createdExpense.id}`);
      assert.strictEqual(status, 200);
      const expense = data as Record<string, unknown>;
      assert.strictEqual(expense.id, createdExpense.id);
      assert.strictEqual(expense.description, 'Coffee');
      assert.strictEqual(expense.amount, 5);
    });

    it('returns 404 for non-existent id', async () => {
      const { status, data } = await httpRequest('GET', port, '/api/expenses/non-existent-id');
      assert.strictEqual(status, 404);
      assert.strictEqual((data as Record<string, unknown>).error, 'Expense not found');
    });
  });

  describe('PUT /api/expenses/:id', () => {
    it('updates fields and returns updated expense', async () => {
      const { data: created } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Old description',
        amount: 20,
        category: 'Food',
      });
      const { id } = created as Record<string, unknown>;

      const { status, data } = await httpRequest('PUT', port, `/api/expenses/${id}`, {
        description: 'Updated description',
        amount: 30,
      });
      assert.strictEqual(status, 200);
      const updated = data as Record<string, unknown>;
      assert.strictEqual(updated.description, 'Updated description');
      assert.strictEqual(updated.amount, 30);
      assert.strictEqual(updated.category, 'Food'); // unchanged
    });

    it('returns 404 for non-existent id', async () => {
      const { status, data } = await httpRequest('PUT', port, '/api/expenses/non-existent', {
        description: 'Test',
      });
      assert.strictEqual(status, 404);
      assert.strictEqual((data as Record<string, unknown>).error, 'Expense not found');
    });

    it('returns 400 for invalid JSON body', async () => {
      const { data: created } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Test',
        amount: 10,
        category: 'Food',
      });
      const { id } = created as Record<string, unknown>;

      const { status, data } = await httpRequest('PUT', port, `/api/expenses/${id}`, { raw: 'bad json' });
      assert.strictEqual(status, 400);
      assert.strictEqual((data as Record<string, unknown>).error, 'Invalid JSON body');
    });

    it('returns 400 for invalid amount type', async () => {
      const { data: created } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Test',
        amount: 10,
        category: 'Food',
      });
      const { id } = created as Record<string, unknown>;

      const { status, data } = await httpRequest('PUT', port, `/api/expenses/${id}`, {
        amount: 'not-a-number',
      });
      assert.strictEqual(status, 400);
      assert.ok(((data as Record<string, unknown>).error as string).includes('amount'));
    });

    it('returns 400 for invalid category', async () => {
      const { data: created } = await httpRequest('POST', port, '/api/expenses', {
        description: 'Test',
        amount: 10,
        category: 'Food',
      });
      const { id } = created as Record<string, unknown>;

      const { status, data } = await httpRequest('PUT', port, `/api/expenses/${id}`, {
        category: 'NotARealCategory',
      });
      assert.strictEqual(status, 400);
      assert.ok(((data as Record<string, unknown>).error as string).includes('category'));
    });
  });

  describe('DELETE /api/expenses/:id', () => {
    it('deletes and returns 204', async () => {
      const { data: created } = await httpRequest('POST', port, '/api/expenses', {
        description: 'To delete',
        amount: 5,
        category: 'Food',
      });
      const { id } = created as Record<string, unknown>;

      const { status } = await httpRequest('DELETE', port, `/api/expenses/${id}`);
      assert.strictEqual(status, 204);

      // Verify it's gone
      const { status: getStatus } = await httpRequest('GET', port, `/api/expenses/${id}`);
      assert.strictEqual(getStatus, 404);
    });

    it('returns 404 for non-existent id', async () => {
      const { status, data } = await httpRequest('DELETE', port, '/api/expenses/non-existent');
      assert.strictEqual(status, 404);
      assert.strictEqual((data as Record<string, unknown>).error, 'Expense not found');
    });
  });

  describe('Static file serving', () => {
    it('GET / returns index.html with text/html Content-Type', async () => {
      const { status, data, headers } = await httpRequest('GET', port, '/');
      assert.strictEqual(status, 200);
      assert.ok(headers['content-type']?.includes('text/html'));
      assert.ok(typeof data === 'string');
      assert.ok((data as string).includes('<!DOCTYPE html>'));
      assert.ok((data as string).includes('Expense Tracker'));
    });

    it('serves style.css with text/css Content-Type', async () => {
      const { status, data, headers } = await httpRequest('GET', port, '/style.css');
      assert.strictEqual(status, 200);
      assert.ok(headers['content-type']?.includes('text/css'));
      assert.ok(typeof data === 'string');
      assert.ok((data as string).includes('font-family'));
    });

    it('serves app.js with text/javascript Content-Type', async () => {
      const { status, data, headers } = await httpRequest('GET', port, '/app.js');
      assert.strictEqual(status, 200);
      assert.ok(headers['content-type']?.includes('text/javascript'));
      assert.ok(typeof data === 'string');
      assert.ok((data as string).includes('DOMContentLoaded'));
    });

    it('returns 404 for non-existent static file', async () => {
      const { status } = await httpRequest('GET', port, '/nonexistent.css');
      assert.strictEqual(status, 404);
    });

    it('returns 404 for non-.css/.js path (not HTML index)', async () => {
      const { status } = await httpRequest('GET', port, '/somefile.txt');
      assert.strictEqual(status, 404);
    });

    it('rejects path traversal attempts', async () => {
      const { status } = await httpRequest('GET', port, '/../src/store.ts');
      assert.strictEqual(status, 404);
    });

    it('POST / returns 404 (static serving only for GET)', async () => {
      const { status } = await httpRequest('POST', port, '/');
      assert.strictEqual(status, 404);
    });
  });

  describe('General', () => {
    it('returns 404 for unknown routes', async () => {
      const { status } = await httpRequest('GET', port, '/api/nonexistent');
      assert.strictEqual(status, 404);
    });

    it('returns Content-Type application/json on error responses', async () => {
      const { status, headers } = await httpRequest('GET', port, '/api/expenses/non-existent-id');
      assert.strictEqual(status, 404);
      assert.ok(headers['content-type']?.includes('application/json'));
    });
  });
});
