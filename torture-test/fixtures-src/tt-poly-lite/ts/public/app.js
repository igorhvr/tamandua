// VULN-T1: uses innerHTML for rendering descriptions — dormant in green baseline
document.addEventListener('DOMContentLoaded', () => {
  const expensesTbody = document.getElementById('expenses-tbody');
  const emptyMessage = document.getElementById('empty-message');
  const errorMessage = document.getElementById('error-message');
  const expenseForm = document.getElementById('expense-form');
  const totalAmount = document.getElementById('total-amount');
  const categoryFilter = document.getElementById('category-filter');

  const descriptionInput = document.getElementById('description');
  const amountInput = document.getElementById('amount');
  const categoryInput = document.getElementById('category');

  let errorDismissTimer = null;

  function showError(message) {
    errorMessage.textContent = message;
    errorMessage.style.display = 'block';
    if (errorDismissTimer) clearTimeout(errorDismissTimer);
    errorDismissTimer = setTimeout(() => {
      errorMessage.style.display = 'none';
      errorDismissTimer = null;
    }, 5000);
  }

  function hideError() {
    errorMessage.style.display = 'none';
    if (errorDismissTimer) {
      clearTimeout(errorDismissTimer);
      errorDismissTimer = null;
    }
  }

  function updateTotal(expenses) {
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    totalAmount.textContent = '$' + total.toFixed(2);
  }

  async function fetchExpenses() {
    try {
      const category = categoryFilter.value;
      const url = category ? '/api/expenses?category=' + encodeURIComponent(category) : '/api/expenses';
      const response = await fetch(url);
      if (!response.ok) {
        showError('Failed to load expenses');
        return;
      }
      const expenses = await response.json();
      renderExpenses(expenses);
      updateTotal(expenses);
    } catch (err) {
      showError('Network error: could not load expenses');
    }
  }

  async function deleteExpense(id) {
    hideError();
    try {
      const response = await fetch('/api/expenses/' + encodeURIComponent(id), {
        method: 'DELETE',
      });
      if (!response.ok) {
        const errorData = await response.json();
        showError(errorData.error || 'Failed to delete expense');
        return;
      }
      await fetchExpenses();
    } catch (err) {
      showError('Network error: could not delete expense');
    }
  }

  function startEdit(tr, expense) {
    const cells = tr.querySelectorAll('td');

    // Description cell
    const oldDesc = expense.description;
    cells[0].innerHTML = '<input type="text" class="edit-input" value="' + escapeAttr(oldDesc) + '" data-field="description">';

    // Amount cell
    cells[1].innerHTML = '<input type="number" class="edit-input edit-amount" value="' + expense.amount + '" step="0.01" min="0" data-field="amount">';

    // Category cell
    const categories = ['Food', 'Transport', 'Utilities', 'Entertainment', 'Other'];
    let catSelect = '<select class="edit-select" data-field="category">';
    for (const cat of categories) {
      const selected = cat === expense.category ? ' selected' : '';
      catSelect += '<option value="' + cat + '"' + selected + '>' + cat + '</option>';
    }
    catSelect += '</select>';
    cells[2].innerHTML = catSelect;

    // Date cell — read-only in edit mode
    cells[3].textContent = expense.date;

    // Actions cell
    cells[4].innerHTML = '<button class="btn-save">Save</button><button class="btn-cancel">Cancel</button>';

    // Save handler
    cells[4].querySelector('.btn-save').addEventListener('click', async () => {
      const descInput = tr.querySelector('[data-field="description"]');
      const amountInput = tr.querySelector('[data-field="amount"]');
      const catSelect = tr.querySelector('[data-field="category"]');

      const newDesc = descInput.value.trim();
      const newAmount = parseFloat(amountInput.value);

      if (!newDesc) {
        showError('Description is required');
        return;
      }
      if (isNaN(newAmount)) {
        showError('Amount must be a number');
        return;
      }

      hideError();
      try {
        const response = await fetch('/api/expenses/' + encodeURIComponent(expense.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ description: newDesc, amount: newAmount, category: catSelect.value }),
        });
        if (!response.ok) {
          const errorData = await response.json();
          showError(errorData.error || 'Failed to update expense');
          return;
        }
        await fetchExpenses();
      } catch (err) {
        showError('Network error: could not update expense');
      }
    });

    // Cancel handler
    cells[4].querySelector('.btn-cancel').addEventListener('click', () => {
      // Re-render the row in display mode
      renderRow(tr, expense);
    });
  }

  function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderRow(tr, expense) {
    tr.innerHTML = '';

    const descTd = document.createElement('td');
    descTd.innerHTML = expense.description;

    const amountTd = document.createElement('td');
    amountTd.className = 'amount-column amount-positive';
    amountTd.textContent = '$' + expense.amount.toFixed(2);

    const categoryTd = document.createElement('td');
    categoryTd.textContent = expense.category;

    const dateTd = document.createElement('td');
    dateTd.textContent = expense.date;

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-column';

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-edit';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => startEdit(tr, expense));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      if (confirm('Delete this expense?')) {
        deleteExpense(expense.id);
      }
    });

    actionsTd.appendChild(editBtn);
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(descTd);
    tr.appendChild(amountTd);
    tr.appendChild(categoryTd);
    tr.appendChild(dateTd);
    tr.appendChild(actionsTd);
  }

  function renderExpenses(expenses) {
    expensesTbody.innerHTML = '';

    if (expenses.length === 0) {
      emptyMessage.style.display = 'block';
      return;
    }

    emptyMessage.style.display = 'none';

    for (const expense of expenses) {
      const tr = document.createElement('tr');
      renderRow(tr, expense);
      expensesTbody.appendChild(tr);
    }
  }

  expenseForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const description = descriptionInput.value.trim();
    const amount = parseFloat(amountInput.value);
    const category = categoryInput.value;

    if (!description || isNaN(amount) || !category) {
      showError('Please fill in all fields');
      return;
    }

    hideError();

    try {
      const response = await fetch('/api/expenses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description, amount, category }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        showError(errorData.error || 'Failed to add expense');
        return;
      }

      // Clear form
      expenseForm.reset();

      // Refresh the list
      await fetchExpenses();
    } catch (err) {
      showError('Network error: could not add expense');
    }
  });

  categoryFilter.addEventListener('change', () => {
    fetchExpenses();
  });

  // Initial load
  fetchExpenses();
});
