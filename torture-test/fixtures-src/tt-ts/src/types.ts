export interface Expense {
  id: string;
  description: string;
  amount: number;
  category: Category;
  date: string; // ISO 8601 date string
}

export type Category = 'Food' | 'Transport' | 'Utilities' | 'Entertainment' | 'Other';

export type UpdateExpense = Partial<Omit<Expense, 'id'>>;
