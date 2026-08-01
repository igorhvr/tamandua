package com.tamandua.ledger;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Business logic service for filtering, aggregating, and sorting
 * ledger entries.
 * <p>
 * All methods are null-safe: a null input list is treated as an
 * empty list, and entries with null amounts are silently skipped.
 * </p>
 */
public final class LedgerService {

    private LedgerService() {
        // utility class
    }

    /**
     * Returns entries matching the given category, case-insensitively.
     *
     * @param entries  list to filter (nullable, empty when null)
     * @param category target category (null returns empty list)
     * @return filtered list (new mutable list, not a view)
     */
    public static List<LedgerEntry> getByCategory(List<LedgerEntry> entries, String category) {
        List<LedgerEntry> result = new ArrayList<>();
        List<LedgerEntry> safe = (entries != null) ? entries : Collections.emptyList();
        if (category == null) {
            return result;
        }
        String lower = category.toLowerCase();
        for (LedgerEntry e : safe) {
            if (e.getCategory() != null && e.getCategory().toLowerCase().equals(lower)) {
                result.add(e);
            }
        }
        return result;
    }

    /**
     * Returns entries whose date falls within the inclusive range
     * {@code [start, end]}.
     *
     * @param entries list to filter (nullable, empty when null)
     * @param start   inclusive start date (null means unbounded start)
     * @param end     inclusive end date (null means unbounded end)
     * @return filtered list (new mutable list)
     */
    public static List<LedgerEntry> getByDateRange(List<LedgerEntry> entries, LocalDate start, LocalDate end) {
        List<LedgerEntry> result = new ArrayList<>();
        List<LedgerEntry> safe = (entries != null) ? entries : Collections.emptyList();
        for (LedgerEntry e : safe) {
            LocalDate d = e.getDate();
            if (d == null) continue;
            boolean afterStart = (start == null) || !d.isBefore(start);
            boolean beforeEnd = (end == null) || !d.isAfter(end);
            if (afterStart && beforeEnd) {
                result.add(e);
            }
        }
        return result;
    }

    /**
     * Sums the amounts of all entries, skipping entries with null amounts.
     *
     * @param entries list to sum (nullable, empty when null)
     * @return total sum (never null, {@code BigDecimal.ZERO} for empty/null input)
     */
    public static BigDecimal getTotal(List<LedgerEntry> entries) {
        List<LedgerEntry> safe = (entries != null) ? entries : Collections.emptyList();
        BigDecimal total = BigDecimal.ZERO;
        for (LedgerEntry e : safe) {
            BigDecimal amt = e.getAmount();
            if (amt != null) {
                total = MoneyUtils.add(total, amt);
            }
        }
        return total;
    }

    /**
     * Computes per-category totals, returning a {@link TreeMap} sorted
     * alphabetically by category name. Entries with null categories or
     * null amounts are skipped.
     *
     * @param entries list to aggregate (nullable, empty when null)
     * @return sorted map from category name to total amount
     */
    public static Map<String, BigDecimal> getCategoryTotals(List<LedgerEntry> entries) {
        Map<String, BigDecimal> totals = new TreeMap<>();
        List<LedgerEntry> safe = (entries != null) ? entries : Collections.emptyList();
        for (LedgerEntry e : safe) {
            String cat = e.getCategory();
            BigDecimal amt = e.getAmount();
            if (cat == null || amt == null) continue;
            totals.merge(cat, amt, MoneyUtils::add);
        }
        return totals;
    }

    /**
     * Returns a new list containing the same entries, sorted by amount
     * ascending. Entries with equal amounts are ordered by date (earlier
     * first). Entries with null amounts or null dates are placed at the
     * end.
     *
     * @param entries list to sort (nullable, empty when null)
     * @return new sorted list (original is not modified)
     */
    public static List<LedgerEntry> getSortedByAmount(List<LedgerEntry> entries) {
        List<LedgerEntry> result = new ArrayList<>();
        if (entries != null) {
            result.addAll(entries);
        }
        result.sort(Comparator.nullsLast(
                Comparator.comparing(LedgerEntry::getAmount,
                        Comparator.nullsLast(BigDecimal::compareTo))
                        .thenComparing(LedgerEntry::getDate,
                                Comparator.nullsLast(LocalDate::compareTo))
        ));
        return result;
    }

    /**
     * Returns the number of entries in the list.
     *
     * @param entries list to count (nullable, 0 when null)
     * @return entry count
     */
    public static int getCount(List<LedgerEntry> entries) {
        return (entries != null) ? entries.size() : 0;
    }
}
