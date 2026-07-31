import type { Expense, Category, UpdateExpense } from './types.js';

export class InMemoryStore {
  #expenses: Expense[] = [];

  getAll(): Expense[] {
    return [...this.#expenses];
  }

  getById(id: string): Expense | undefined {
    return this.#expenses.find(e => e.id === id);
  }

  getByCategory(category: Category): Expense[] {
    return this.#expenses.filter(e => e.category === category);
  }

  getByDateRange(startDate: string, endDate: string): Expense[] {
    return this.#expenses.filter(e => e.date >= startDate && e.date <= endDate);
  }

  add(expense: Expense): Expense {
    this.#expenses.push(expense);
    return expense;
  }

  update(id: string, updates: UpdateExpense): Expense | undefined {
    const index = this.#expenses.findIndex(e => e.id === id);
    if (index === -1) return undefined;

    const existing = this.#expenses[index];
    const updated: Expense = { ...existing, ...updates };
    this.#expenses[index] = updated;
    return updated;
  }

  delete(id: string): boolean {
    const index = this.#expenses.findIndex(e => e.id === id);
    if (index === -1) return false;
    this.#expenses.splice(index, 1);
    return true;
  }

  getTotal(): number {
    return this.#expenses.reduce((sum, e) => sum + e.amount, 0);
  }

  getCategorySummary(): Record<Category, number> {
    const summary: Record<Category, number> = {
      Food: 0,
      Transport: 0,
      Utilities: 0,
      Entertainment: 0,
      Other: 0,
    };
    for (const e of this.#expenses) {
      summary[e.category] += e.amount;
    }
    return summary;
  }
}
