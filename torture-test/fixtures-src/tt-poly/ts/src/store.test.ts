import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { InMemoryStore } from './store.js';
import type { Expense, Category } from './types.js';

function makeExpense(overrides: Partial<Expense> & { id?: string } = {}): Expense {
  const id = overrides.id ?? `exp-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    description: overrides.description ?? 'Test expense',
    amount: overrides.amount ?? 10,
    category: overrides.category ?? 'Food',
    date: overrides.date ?? '2025-01-15',
  };
}

describe('InMemoryStore', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  describe('getAll', () => {
    it('returns empty array for new store', () => {
      assert.deepStrictEqual(store.getAll(), []);
    });

    it('returns all added expenses', () => {
      const e1 = store.add(makeExpense({ id: '1', description: 'Groceries' }));
      const e2 = store.add(makeExpense({ id: '2', description: 'Gas' }));
      const all = store.getAll();
      assert.strictEqual(all.length, 2);
      assert.deepStrictEqual(all, [e1, e2]);
    });

    it('returns a copy, not the internal array', () => {
      store.add(makeExpense({ id: '1' }));
      const all = store.getAll();
      all.push(makeExpense({ id: '2' }));
      assert.strictEqual(store.getAll().length, 1);
    });
  });

  describe('getById', () => {
    it('returns the expense with matching id', () => {
      const exp = store.add(makeExpense({ id: 'abc', description: 'Rent' }));
      const found = store.getById('abc');
      assert.deepStrictEqual(found, exp);
    });

    it('returns undefined for non-existent id', () => {
      store.add(makeExpense({ id: 'abc' }));
      assert.strictEqual(store.getById('nonexistent'), undefined);
    });

    it('returns undefined for empty store', () => {
      assert.strictEqual(store.getById('any'), undefined);
    });
  });

  describe('getByCategory', () => {
    it('returns only expenses of the given category', () => {
      store.add(makeExpense({ id: '1', category: 'Food', description: 'Groceries' }));
      store.add(makeExpense({ id: '2', category: 'Food', description: 'Restaurant' }));
      store.add(makeExpense({ id: '3', category: 'Transport', description: 'Bus' }));

      const food = store.getByCategory('Food');
      assert.strictEqual(food.length, 2);
      assert(food.every(e => e.category === 'Food'));
    });

    it('returns empty array when no expenses match category', () => {
      store.add(makeExpense({ id: '1', category: 'Food' }));
      const transport = store.getByCategory('Transport');
      assert.deepStrictEqual(transport, []);
    });

    it('returns empty array for empty store', () => {
      assert.deepStrictEqual(store.getByCategory('Food'), []);
    });
  });

  describe('getByDateRange', () => {
    it('returns expenses within the date range inclusive', () => {
      store.add(makeExpense({ id: '1', date: '2025-01-10' }));
      store.add(makeExpense({ id: '2', date: '2025-01-15' }));
      store.add(makeExpense({ id: '3', date: '2025-01-20' }));

      const range = store.getByDateRange('2025-01-10', '2025-01-15');
      assert.strictEqual(range.length, 2);
      const ids = range.map(e => e.id).sort();
      assert.deepStrictEqual(ids, ['1', '2']);
    });

    it('returns empty array when no expenses in range', () => {
      store.add(makeExpense({ id: '1', date: '2025-01-10' }));
      const range = store.getByDateRange('2025-01-15', '2025-01-20');
      assert.deepStrictEqual(range, []);
    });

    it('handles single-day range with boundary date', () => {
      store.add(makeExpense({ id: '1', date: '2025-01-15' }));
      store.add(makeExpense({ id: '2', date: '2025-01-15' }));
      store.add(makeExpense({ id: '3', date: '2025-01-16' }));

      const range = store.getByDateRange('2025-01-15', '2025-01-15');
      assert.strictEqual(range.length, 2);
    });

    it('returns empty array for empty store', () => {
      assert.deepStrictEqual(store.getByDateRange('2025-01-01', '2025-12-31'), []);
    });
  });

  describe('add', () => {
    it('adds an expense and returns the same object', () => {
      const exp = makeExpense({ id: 'new-1', description: 'Coffee', amount: 5 });
      const result = store.add(exp);
      assert.strictEqual(result, exp);
      assert.strictEqual(store.getAll().length, 1);
    });

    it('allows duplicate ids (no uniqueness enforcement)', () => {
      const e1 = store.add(makeExpense({ id: 'dup', description: 'First' }));
      const e2 = store.add(makeExpense({ id: 'dup', description: 'Second' }));
      assert.strictEqual(store.getAll().length, 2);
    });

    it('accepts negative amounts', () => {
      const exp = makeExpense({ id: '1', amount: -50 });
      store.add(exp);
      assert.strictEqual(store.getById('1')!.amount, -50);
    });
  });

  describe('update', () => {
    it('updates existing expense fields', () => {
      store.add(makeExpense({ id: '1', description: 'Old', amount: 10, category: 'Food' }));
      const updated = store.update('1', { description: 'New', amount: 20 });
      assert.ok(updated);
      assert.strictEqual(updated!.description, 'New');
      assert.strictEqual(updated!.amount, 20);
      assert.strictEqual(updated!.category, 'Food'); // unchanged
    });

    it('returns undefined for non-existent id', () => {
      store.add(makeExpense({ id: '1' }));
      assert.strictEqual(store.update('nonexistent', { description: 'x' }), undefined);
    });

    it('returns undefined for empty store', () => {
      assert.strictEqual(store.update('any', { description: 'x' }), undefined);
    });

    it('does not modify other fields', () => {
      store.add(makeExpense({ id: '1', description: 'Original', amount: 10, category: 'Food', date: '2025-01-15' }));
      store.update('1', { amount: 25 });
      const exp = store.getById('1')!;
      assert.strictEqual(exp.description, 'Original');
      assert.strictEqual(exp.amount, 25);
      assert.strictEqual(exp.category, 'Food');
      assert.strictEqual(exp.date, '2025-01-15');
    });
  });

  describe('delete', () => {
    it('removes an existing expense and returns true', () => {
      store.add(makeExpense({ id: '1' }));
      assert.strictEqual(store.getAll().length, 1);
      const result = store.delete('1');
      assert.strictEqual(result, true);
      assert.strictEqual(store.getAll().length, 0);
    });

    it('returns false for non-existent id', () => {
      store.add(makeExpense({ id: '1' }));
      assert.strictEqual(store.delete('nonexistent'), false);
      assert.strictEqual(store.getAll().length, 1);
    });

    it('returns false for empty store', () => {
      assert.strictEqual(store.delete('any'), false);
    });
  });

  describe('getTotal', () => {
    it('returns 0 for empty store', () => {
      assert.strictEqual(store.getTotal(), 0);
    });

    it('returns sum of all expense amounts', () => {
      store.add(makeExpense({ id: '1', amount: 10 }));
      store.add(makeExpense({ id: '2', amount: 20 }));
      store.add(makeExpense({ id: '3', amount: 30 }));
      assert.strictEqual(store.getTotal(), 60);
    });

    it('handles negative amounts', () => {
      store.add(makeExpense({ id: '1', amount: 100 }));
      store.add(makeExpense({ id: '2', amount: -30 }));
      assert.strictEqual(store.getTotal(), 70);
    });
  });

  describe('getCategorySummary', () => {
    it('returns all zero for empty store', () => {
      const summary = store.getCategorySummary();
      assert.deepStrictEqual(summary, {
        Food: 0,
        Transport: 0,
        Utilities: 0,
        Entertainment: 0,
        Other: 0,
      });
    });

    it('returns grouped totals by category', () => {
      store.add(makeExpense({ id: '1', category: 'Food', amount: 10 }));
      store.add(makeExpense({ id: '2', category: 'Food', amount: 15 }));
      store.add(makeExpense({ id: '3', category: 'Transport', amount: 20 }));
      store.add(makeExpense({ id: '4', category: 'Entertainment', amount: 50 }));

      const summary = store.getCategorySummary();
      assert.strictEqual(summary.Food, 25);
      assert.strictEqual(summary.Transport, 20);
      assert.strictEqual(summary.Entertainment, 50);
      assert.strictEqual(summary.Utilities, 0);
      assert.strictEqual(summary.Other, 0);
    });
  });
});
