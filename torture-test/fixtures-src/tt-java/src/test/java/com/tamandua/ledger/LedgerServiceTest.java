package com.tamandua.ledger;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Tests for {@link LedgerService}.
 */
class LedgerServiceTest {

    /**
     * Creates a small sample dataset of 6 {@link LedgerEntry} objects
     * for reuse across tests.
     * <pre>
     *   [0] food   100.00   2025-01-10
     *   [1] food    50.00   2025-01-11
     *   [2] transport  75.00   2025-02-01
     *   [3] entertainment  150.00   2025-03-15
     *   [4] food  25.00   2025-01-12
     *   [5] transport  75.00   2025-01-31  (same amount as [2], different date)
     * </pre>
     */
    static List<LedgerEntry> createSampleEntries() {
        List<LedgerEntry> entries = new ArrayList<>();
        entries.add(LedgerEntry.of("id-1", LocalDate.of(2025, 1, 10), "Groceries", new BigDecimal("100.00"), "food"));
        entries.add(LedgerEntry.of("id-2", LocalDate.of(2025, 1, 11), "Restaurant", new BigDecimal("50.00"), "food"));
        entries.add(LedgerEntry.of("id-3", LocalDate.of(2025, 2, 1), "Bus pass", new BigDecimal("75.00"), "transport"));
        entries.add(LedgerEntry.of("id-4", LocalDate.of(2025, 3, 15), "Movie", new BigDecimal("150.00"), "entertainment"));
        entries.add(LedgerEntry.of("id-5", LocalDate.of(2025, 1, 12), "Snacks", new BigDecimal("25.00"), "food"));
        entries.add(LedgerEntry.of("id-6", LocalDate.of(2025, 1, 31), "Train", new BigDecimal("75.00"), "transport"));
        return entries;
    }

    // --- getByCategory -------------------------------------------------------

    @Test
    @DisplayName("getByCategory: filters only food entries")
    void getByCategoryFood() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByCategory(entries, "food");
        assertEquals(3, result.size());
        assertTrue(result.stream().allMatch(e -> e.getCategory().equals("food")));
    }

    @Test
    @DisplayName("getByCategory: case-insensitive match — FOOD matches food")
    void getByCategoryCaseInsensitive() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByCategory(entries, "FOOD");
        assertEquals(3, result.size());
    }

    @Test
    @DisplayName("getByCategory: mixed case — FoOd matches food")
    void getByCategoryMixedCase() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByCategory(entries, "FoOd");
        assertEquals(3, result.size());
    }

    @Test
    @DisplayName("getByCategory: no matches returns empty list")
    void getByCategoryNoMatches() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByCategory(entries, "healthcare");
        assertEquals(0, result.size());
        assertTrue(result.isEmpty());
    }

    @Test
    @DisplayName("getByCategory: null category returns empty list")
    void getByCategoryNullCategory() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByCategory(entries, null);
        assertEquals(0, result.size());
    }

    @Test
    @DisplayName("getByCategory: null entries list returns empty list")
    void getByCategoryNullEntries() {
        List<LedgerEntry> result = LedgerService.getByCategory(null, "food");
        assertEquals(0, result.size());
        assertTrue(result.isEmpty());
    }

    @Test
    @DisplayName("getByCategory: empty entries list returns empty list")
    void getByCategoryEmptyEntries() {
        List<LedgerEntry> result = LedgerService.getByCategory(Collections.emptyList(), "food");
        assertEquals(0, result.size());
    }

    @Test
    @DisplayName("getByCategory: single match")
    void getByCategorySingleMatch() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByCategory(entries, "entertainment");
        assertEquals(1, result.size());
        assertEquals("id-4", result.get(0).getId());
    }

    @Test
    @DisplayName("getByCategory: all entries same category")
    void getByCategoryAllSameCategory() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> foodOnly = LedgerService.getByCategory(entries, "food");
        assertEquals(3, foodOnly.size());
    }

    // --- getByDateRange ------------------------------------------------------

    @Test
    @DisplayName("getByDateRange: inclusive bounds include boundary entries")
    void getByDateRangeInclusiveBounds() {
        List<LedgerEntry> entries = createSampleEntries();
        // id-1 at 2025-01-10, id-2 at 2025-01-11, id-5 at 2025-01-12
        List<LedgerEntry> result = LedgerService.getByDateRange(entries,
                LocalDate.of(2025, 1, 10), LocalDate.of(2025, 1, 12));
        assertEquals(3, result.size());
    }

    @Test
    @DisplayName("getByDateRange: entries on start date are included")
    void getByDateRangeStartInclusive() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByDateRange(entries,
                LocalDate.of(2025, 1, 10), LocalDate.of(2025, 1, 10));
        assertEquals(1, result.size());
        assertEquals("id-1", result.get(0).getId());
    }

    @Test
    @DisplayName("getByDateRange: entries on end date are included")
    void getByDateRangeEndInclusive() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByDateRange(entries,
                LocalDate.of(2025, 1, 12), LocalDate.of(2025, 1, 12));
        assertEquals(1, result.size());
        assertEquals("id-5", result.get(0).getId());
    }

    @Test
    @DisplayName("getByDateRange: unbounded start (null start)")
    void getByDateRangeUnboundedStart() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByDateRange(entries,
                null, LocalDate.of(2025, 1, 31));
        // Entries on or before 2025-01-31: id-1(01-10), id-2(01-11), id-5(01-12), id-6(01-31) = 4
        assertEquals(4, result.size());
    }

    @Test
    @DisplayName("getByDateRange: unbounded end (null end)")
    void getByDateRangeUnboundedEnd() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByDateRange(entries,
                LocalDate.of(2025, 2, 1), null);
        // Entries on or after 2025-02-01: id-3(02-01), id-4(03-15) = 2
        assertEquals(2, result.size());
    }

    @Test
    @DisplayName("getByDateRange: both bounds null returns all entries")
    void getByDateRangeBothNull() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByDateRange(entries, null, null);
        assertEquals(6, result.size());
    }

    @Test
    @DisplayName("getByDateRange: no matches returns empty list")
    void getByDateRangeNoMatches() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByDateRange(entries,
                LocalDate.of(2024, 1, 1), LocalDate.of(2024, 12, 31));
        assertEquals(0, result.size());
    }

    @Test
    @DisplayName("getByDateRange: single-day range match")
    void getByDateRangeSingleDay() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> result = LedgerService.getByDateRange(entries,
                LocalDate.of(2025, 3, 15), LocalDate.of(2025, 3, 15));
        assertEquals(1, result.size());
        assertEquals("id-4", result.get(0).getId());
    }

    @Test
    @DisplayName("getByDateRange: null entries list returns empty list")
    void getByDateRangeNullEntries() {
        List<LedgerEntry> result = LedgerService.getByDateRange(null,
                LocalDate.of(2025, 1, 1), LocalDate.of(2025, 12, 31));
        assertEquals(0, result.size());
    }

    // --- getTotal ------------------------------------------------------------

    @Test
    @DisplayName("getTotal: sums all amounts in sample dataset")
    void getTotalSampleDataset() {
        List<LedgerEntry> entries = createSampleEntries();
        // 100 + 50 + 75 + 150 + 25 + 75 = 475
        assertEquals(new BigDecimal("475.00"), LedgerService.getTotal(entries));
    }

    @Test
    @DisplayName("getTotal: single entry")
    void getTotalSingleEntry() {
        List<LedgerEntry> entries = List.of(
                LedgerEntry.create(LocalDate.of(2025, 1, 1), "Test", new BigDecimal("42.00"), "food"));
        assertEquals(new BigDecimal("42.00"), LedgerService.getTotal(entries));
    }

    @Test
    @DisplayName("getTotal: empty list returns ZERO")
    void getTotalEmptyList() {
        assertEquals(BigDecimal.ZERO, LedgerService.getTotal(Collections.emptyList()));
    }

    @Test
    @DisplayName("getTotal: null list returns ZERO")
    void getTotalNullList() {
        assertEquals(BigDecimal.ZERO, LedgerService.getTotal(null));
    }

    @Test
    @DisplayName("getTotal: works with entries that have non-null amounts")
    void getTotalHandlesNormalEntries() {
        List<LedgerEntry> entries = new ArrayList<>();
        entries.add(LedgerEntry.create(LocalDate.of(2025, 1, 1), "A", new BigDecimal("100.00"), "food"));
        entries.add(LedgerEntry.create(LocalDate.of(2025, 1, 2), "B", new BigDecimal("0.00"), "food"));
        entries.add(LedgerEntry.create(LocalDate.of(2025, 1, 3), "C", new BigDecimal("50.00"), "food"));
        assertEquals(new BigDecimal("150.00"), LedgerService.getTotal(entries));
    }

    @Test
    @DisplayName("getTotal: negative amounts handled correctly")
    void getTotalNegativeAmounts() {
        List<LedgerEntry> entries = new ArrayList<>();
        entries.add(LedgerEntry.create(LocalDate.of(2025, 1, 1), "Income", new BigDecimal("500.00"), "salary"));
        entries.add(LedgerEntry.create(LocalDate.of(2025, 1, 2), "Expense", new BigDecimal("-200.00"), "bills"));
        assertEquals(new BigDecimal("300.00"), LedgerService.getTotal(entries));
    }

    // --- getCategoryTotals ---------------------------------------------------

    @Test
    @DisplayName("getCategoryTotals: returns correct totals per category")
    void getCategoryTotalsSample() {
        List<LedgerEntry> entries = createSampleEntries();
        Map<String, BigDecimal> result = LedgerService.getCategoryTotals(entries);
        assertEquals(3, result.size());
        // food: 100 + 50 + 25 = 175
        assertEquals(new BigDecimal("175.00"), result.get("food"));
        // transport: 75 + 75 = 150
        assertEquals(new BigDecimal("150.00"), result.get("transport"));
        // entertainment: 150
        assertEquals(new BigDecimal("150.00"), result.get("entertainment"));
    }

    @Test
    @DisplayName("getCategoryTotals: sorted alphabetically")
    void getCategoryTotalsSorted() {
        List<LedgerEntry> entries = createSampleEntries();
        Map<String, BigDecimal> result = LedgerService.getCategoryTotals(entries);
        // TreeMap should sort: entertainment < food < transport
        List<String> keys = new ArrayList<>(result.keySet());
        assertEquals("entertainment", keys.get(0));
        assertEquals("food", keys.get(1));
        assertEquals("transport", keys.get(2));
    }

    @Test
    @DisplayName("getCategoryTotals: single category")
    void getCategoryTotalsSingleCategory() {
        List<LedgerEntry> entries = new ArrayList<>();
        entries.add(LedgerEntry.create(LocalDate.of(2025, 1, 1), "A", new BigDecimal("10.00"), "single"));
        entries.add(LedgerEntry.create(LocalDate.of(2025, 1, 2), "B", new BigDecimal("20.00"), "single"));
        Map<String, BigDecimal> result = LedgerService.getCategoryTotals(entries);
        assertEquals(1, result.size());
        assertEquals(new BigDecimal("30.00"), result.get("single"));
    }

    @Test
    @DisplayName("getCategoryTotals: multiple entries with same category sum correctly")
    void getCategoryTotalsMultipleEntriesSumCorrectly() {
        List<LedgerEntry> entries = new ArrayList<>();
        entries.add(LedgerEntry.create(LocalDate.of(2025, 1, 1), "A", new BigDecimal("10.00"), "food"));
        entries.add(LedgerEntry.create(LocalDate.of(2025, 1, 2), "B", new BigDecimal("20.00"), "food"));
        entries.add(LedgerEntry.create(LocalDate.of(2025, 1, 3), "C", new BigDecimal("5.00"), "food"));
        Map<String, BigDecimal> result = LedgerService.getCategoryTotals(entries);
        assertEquals(1, result.size());
        assertEquals(new BigDecimal("35.00"), result.get("food"));
    }

    @Test
    @DisplayName("getCategoryTotals: handles large variety of categories and amounts")
    void getCategoryTotalsLargeVariety() {
        List<LedgerEntry> entries = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            entries.add(LedgerEntry.create(
                    LocalDate.of(2025, 1, i + 1),
                    "Item " + i,
                    new BigDecimal(String.valueOf(10 * (i + 1))),
                    "category-" + (char) ('a' + i % 5)
            ));
        }
        Map<String, BigDecimal> result = LedgerService.getCategoryTotals(entries);
        assertEquals(5, result.size());
        // Sorted: a, b, c, d, e
        List<String> keys = new ArrayList<>(result.keySet());
        assertEquals("category-a", keys.get(0));
        assertEquals("category-e", keys.get(4));
    }

    @Test
    @DisplayName("getCategoryTotals: empty list returns empty map")
    void getCategoryTotalsEmptyList() {
        Map<String, BigDecimal> result = LedgerService.getCategoryTotals(Collections.emptyList());
        assertTrue(result.isEmpty());
    }

    @Test
    @DisplayName("getCategoryTotals: null list returns empty map")
    void getCategoryTotalsNullList() {
        Map<String, BigDecimal> result = LedgerService.getCategoryTotals(null);
        assertTrue(result.isEmpty());
    }

    // --- getSortedByAmount ---------------------------------------------------

    @Test
    @DisplayName("getSortedByAmount: ascending order by amount")
    void getSortedByAmountAscending() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> sorted = LedgerService.getSortedByAmount(entries);
        // Expected order: 25.00 (id-5), 50.00 (id-2), 75.00 (id-6, earlier date),
        // 75.00 (id-3, later date), 100.00 (id-1), 150.00 (id-4)
        assertEquals("id-5", sorted.get(0).getId()); // 25.00
        assertEquals("id-2", sorted.get(1).getId()); // 50.00
        assertEquals("id-6", sorted.get(2).getId()); // 75.00, 2025-01-31
        assertEquals("id-3", sorted.get(3).getId()); // 75.00, 2025-02-01
        assertEquals("id-1", sorted.get(4).getId()); // 100.00
        assertEquals("id-4", sorted.get(5).getId()); // 150.00
    }

    @Test
    @DisplayName("getSortedByAmount: tie broken by date (earlier first)")
    void getSortedByAmountTieByDate() {
        List<LedgerEntry> entries = new ArrayList<>();
        entries.add(LedgerEntry.of("later", LocalDate.of(2025, 2, 1), "Later", new BigDecimal("50.00"), "food"));
        entries.add(LedgerEntry.of("earlier", LocalDate.of(2025, 1, 1), "Earlier", new BigDecimal("50.00"), "food"));
        List<LedgerEntry> sorted = LedgerService.getSortedByAmount(entries);
        assertEquals("earlier", sorted.get(0).getId());
        assertEquals("later", sorted.get(1).getId());
    }

    @Test
    @DisplayName("getSortedByAmount: original list is unchanged")
    void getSortedByAmountOriginalUnchanged() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> copy = new ArrayList<>(entries);
        LedgerService.getSortedByAmount(entries);
        assertEquals(copy, entries, "original list should not be modified");
    }

    @Test
    @DisplayName("getSortedByAmount: returns a new list instance")
    void getSortedByAmountReturnsNewList() {
        List<LedgerEntry> entries = createSampleEntries();
        List<LedgerEntry> sorted = LedgerService.getSortedByAmount(entries);
        assertNotSame(entries, sorted);
    }

    @Test
    @DisplayName("getSortedByAmount: null entries list returns empty list")
    void getSortedByAmountNullEntries() {
        List<LedgerEntry> result = LedgerService.getSortedByAmount(null);
        assertTrue(result.isEmpty());
    }

    @Test
    @DisplayName("getSortedByAmount: empty list returns empty list")
    void getSortedByAmountEmpty() {
        List<LedgerEntry> result = LedgerService.getSortedByAmount(Collections.emptyList());
        assertTrue(result.isEmpty());
    }

    @Test
    @DisplayName("getSortedByAmount: single entry returns single-element list")
    void getSortedByAmountSingleEntry() {
        List<LedgerEntry> entries = List.of(
                LedgerEntry.create(LocalDate.of(2025, 1, 1), "Only", new BigDecimal("10.00"), "food"));
        List<LedgerEntry> sorted = LedgerService.getSortedByAmount(entries);
        assertEquals(1, sorted.size());
    }

    // --- getCount ------------------------------------------------------------

    @Test
    @DisplayName("getCount: sample dataset returns 6")
    void getCountSample() {
        assertEquals(6, LedgerService.getCount(createSampleEntries()));
    }

    @Test
    @DisplayName("getCount: empty list returns 0")
    void getCountEmptyList() {
        assertEquals(0, LedgerService.getCount(Collections.emptyList()));
    }

    @Test
    @DisplayName("getCount: null list returns 0")
    void getCountNullList() {
        assertEquals(0, LedgerService.getCount(null));
    }

    @Test
    @DisplayName("getCount: single entry returns 1")
    void getCountSingleEntry() {
        assertEquals(1, LedgerService.getCount(
                List.of(LedgerEntry.create(LocalDate.of(2025, 1, 1), "Test", BigDecimal.ZERO, "food"))));
    }

    // --- null safety across all methods --------------------------------------

    @Test
    @DisplayName("all methods handle null input gracefully (no NPE)")
    void allMethodsNullSafe() {
        assertDoesNotThrow(() -> LedgerService.getByCategory(null, "food"));
        assertDoesNotThrow(() -> LedgerService.getByCategory(null, null));
        assertDoesNotThrow(() -> LedgerService.getByDateRange(null, LocalDate.now(), LocalDate.now()));
        assertDoesNotThrow(() -> LedgerService.getByDateRange(null, null, null));
        assertDoesNotThrow(() -> LedgerService.getTotal(null));
        assertDoesNotThrow(() -> LedgerService.getCategoryTotals(null));
        assertDoesNotThrow(() -> LedgerService.getSortedByAmount(null));
        assertDoesNotThrow(() -> LedgerService.getCount(null));
    }

    @Test
    @DisplayName("unmodifiable input list does not cause failures")
    void unmodifiableInputListSafe() {
        List<LedgerEntry> entries = List.copyOf(createSampleEntries());
        assertDoesNotThrow(() -> LedgerService.getByCategory(entries, "food"));
        assertDoesNotThrow(() -> LedgerService.getByDateRange(entries,
                LocalDate.of(2025, 1, 1), LocalDate.of(2025, 12, 31)));
        assertDoesNotThrow(() -> LedgerService.getTotal(entries));
        assertDoesNotThrow(() -> LedgerService.getCategoryTotals(entries));
        assertDoesNotThrow(() -> LedgerService.getSortedByAmount(entries));
        assertEquals(6, LedgerService.getCount(entries));
    }

    // --- performance regression test -----------------------------------------

    @Test
    @DisplayName("regressionBugJ4CategoryTotalsPerformance — O(n) not O(n^2)")
    void regressionBugJ4CategoryTotalsPerformance() {
        // Create 10,000 entries across 5 categories × 2,000 each
        List<LedgerEntry> large = new ArrayList<>();
        String[] categories = {"food", "transport", "entertainment", "utilities", "shopping"};
        for (int i = 0; i < 10000; i++) {
            String cat = categories[i % 5];
            BigDecimal amount = new BigDecimal(String.valueOf(10 + (i % 900)));
            LocalDate date = LocalDate.of(2025, 1, 1).plusDays(i % 365);
            large.add(LedgerEntry.of("perf-" + i, date, "Item " + i, amount, cat));
        }
        // Must complete in under 500ms — O(n^2) version takes 2-3 seconds
        assertTimeoutPreemptively(Duration.ofMillis(500), () -> {
            Map<String, BigDecimal> totals = LedgerService.getCategoryTotals(large);
            assertEquals(5, totals.size(), "Should have 5 category totals");
            // Verify the totals are non-zero (sanity check)
            for (BigDecimal total : totals.values()) {
                assertTrue(total.compareTo(BigDecimal.ZERO) > 0,
                        "Each category should have a positive total");
            }
        });
    }
}
