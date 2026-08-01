package com.tamandua.ledger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.List;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Tests for {@link MoneyUtils}.
 */
class MoneyUtilsTest {

    // --- add ----------------------------------------------------------------

    @Test
    @DisplayName("add: normal positive values")
    void addPositiveValues() {
        assertEquals(new BigDecimal("300.00"), MoneyUtils.add(new BigDecimal("100.00"), new BigDecimal("200.00")));
    }

    @Test
    @DisplayName("add: negative value with positive")
    void addNegativeWithPositive() {
        assertEquals(new BigDecimal("50.00"), MoneyUtils.add(new BigDecimal("100.00"), new BigDecimal("-50.00")));
    }

    @Test
    @DisplayName("add: zero operand")
    void addWithZero() {
        assertEquals(new BigDecimal("42.00"), MoneyUtils.add(new BigDecimal("42.00"), BigDecimal.ZERO));
        assertEquals(new BigDecimal("42.00"), MoneyUtils.add(BigDecimal.ZERO, new BigDecimal("42.00")));
    }

    @Test
    @DisplayName("add: both nulls return ZERO")
    void addBothNull() {
        assertEquals(BigDecimal.ZERO, MoneyUtils.add(null, null));
    }

    @Test
    @DisplayName("add: first null returns second value")
    void addFirstNull() {
        assertEquals(new BigDecimal("99.99"), MoneyUtils.add(null, new BigDecimal("99.99")));
    }

    @Test
    @DisplayName("add: second null returns first value")
    void addSecondNull() {
        assertEquals(new BigDecimal("77.77"), MoneyUtils.add(new BigDecimal("77.77"), null));
    }

    // --- subtract -----------------------------------------------------------

    @Test
    @DisplayName("subtract: normal positive values")
    void subtractPositiveValues() {
        assertEquals(new BigDecimal("100.00"), MoneyUtils.subtract(new BigDecimal("300.00"), new BigDecimal("200.00")));
    }

    @Test
    @DisplayName("subtract: result can be negative")
    void subtractResultNegative() {
        assertEquals(new BigDecimal("-50.00"), MoneyUtils.subtract(new BigDecimal("100.00"), new BigDecimal("150.00")));
    }

    @Test
    @DisplayName("subtract: both nulls return ZERO")
    void subtractBothNull() {
        assertEquals(BigDecimal.ZERO, MoneyUtils.subtract(null, null));
    }

    @Test
    @DisplayName("subtract: first null, second non-null")
    void subtractFirstNull() {
        assertEquals(new BigDecimal("-25.00"), MoneyUtils.subtract(null, new BigDecimal("25.00")));
    }

    @Test
    @DisplayName("subtract: second null, first non-null")
    void subtractSecondNull() {
        assertEquals(new BigDecimal("50.00"), MoneyUtils.subtract(new BigDecimal("50.00"), null));
    }

    // --- round (3-arg) ------------------------------------------------------

    @Test
    @DisplayName("round: HALF_UP with exact value")
    void roundHalfUpExact() {
        assertEquals(new BigDecimal("2.45"), MoneyUtils.round(new BigDecimal("2.45"), 2, RoundingMode.HALF_UP));
    }

    @Test
    @DisplayName("round: HALF_UP rounding boundary — 2.445 rounds to 2.45")
    void roundHalfUpBoundary445Up() {
        assertEquals(new BigDecimal("2.45"), MoneyUtils.round(new BigDecimal("2.445"), 2, RoundingMode.HALF_UP));
    }

    @Test
    @DisplayName("round: HALF_UP rounding boundary — 2.444 rounds down to 2.44")
    void roundHalfUpBoundary444Down() {
        assertEquals(new BigDecimal("2.44"), MoneyUtils.round(new BigDecimal("2.444"), 2, RoundingMode.HALF_UP));
    }

    @Test
    @DisplayName("round: HALF_UP rounding boundary — 2.446 rounds up to 2.45")
    void roundHalfUpBoundary446Up() {
        assertEquals(new BigDecimal("2.45"), MoneyUtils.round(new BigDecimal("2.446"), 2, RoundingMode.HALF_UP));
    }

    @Test
    @DisplayName("round: HALF_DOWN boundary")
    void roundHalfDown() {
        // HALF_DOWN: 2.445 rounds to 2.44 (ties toward zero)
        assertEquals(new BigDecimal("2.44"), MoneyUtils.round(new BigDecimal("2.445"), 2, RoundingMode.HALF_DOWN));
    }

    @Test
    @DisplayName("round: UP mode")
    void roundUp() {
        assertEquals(new BigDecimal("2.45"), MoneyUtils.round(new BigDecimal("2.441"), 2, RoundingMode.UP));
    }

    @Test
    @DisplayName("round: DOWN mode")
    void roundDown() {
        assertEquals(new BigDecimal("2.44"), MoneyUtils.round(new BigDecimal("2.449"), 2, RoundingMode.DOWN));
    }

    @Test
    @DisplayName("round: null amount returns ZERO scaled")
    void roundNullReturnsZeroScaled() {
        assertEquals(new BigDecimal("0.00"), MoneyUtils.round(null, 2, RoundingMode.HALF_UP));
    }

    @Test
    @DisplayName("round: negative value round up (HALF_UP)")
    void roundNegativeHalfUp() {
        // -2.445 with HALF_UP → setScale rounds away from zero → -2.45
        assertEquals(new BigDecimal("-2.45"), MoneyUtils.round(new BigDecimal("-2.445"), 2, RoundingMode.HALF_UP));
    }

    @Test
    @DisplayName("round: scale 0")
    void roundScaleZero() {
        assertEquals(new BigDecimal("3"), MoneyUtils.round(new BigDecimal("2.5"), 0, RoundingMode.HALF_UP));
    }

    // --- round (1-arg convenience) ------------------------------------------

    @Test
    @DisplayName("round (convenience): defaults to scale 2, HALF_UP")
    void roundConvenienceDefault() {
        assertEquals(new BigDecimal("2.45"), MoneyUtils.round(new BigDecimal("2.445")));
    }

    @Test
    @DisplayName("round (convenience): null returns ZERO")
    void roundConvenienceNull() {
        assertEquals(new BigDecimal("0.00"), MoneyUtils.round(null));
    }

    // --- format -------------------------------------------------------------

    @Test
    @DisplayName("format: simple value")
    void formatSimple() {
        assertEquals("$1.00", MoneyUtils.format(new BigDecimal("1.00")));
    }

    @Test
    @DisplayName("format: with thousands separator")
    void formatThousands() {
        assertEquals("$1,234.56", MoneyUtils.format(new BigDecimal("1234.56")));
    }

    @Test
    @DisplayName("format: negative value")
    void formatNegative() {
        assertEquals("-$100.00", MoneyUtils.format(new BigDecimal("-100.00")));
    }

    @Test
    @DisplayName("format: zero")
    void formatZero() {
        assertEquals("$0.00", MoneyUtils.format(BigDecimal.ZERO));
    }

    @Test
    @DisplayName("format: null returns $0.00")
    void formatNull() {
        assertEquals("$0.00", MoneyUtils.format(null));
    }

    @Test
    @DisplayName("format: large value")
    void formatLargeValue() {
        assertEquals("$9,999,999.99", MoneyUtils.format(new BigDecimal("9999999.99")));
    }

    // --- parse --------------------------------------------------------------

    @Test
    @DisplayName("parse: plain decimal string")
    void parsePlainDecimal() {
        assertEquals(new BigDecimal("1000.50"), MoneyUtils.parse("1000.50"));
    }

    @Test
    @DisplayName("parse: currency formatted string")
    void parseCurrencyFormatted() {
        assertEquals(new BigDecimal("1234.56"), MoneyUtils.parse("$1,234.56"));
    }

    @Test
    @DisplayName("parse: negative currency string")
    void parseNegativeCurrency() {
        assertEquals(new BigDecimal("-100.00"), MoneyUtils.parse("-$100.00"));
    }

    @Test
    @DisplayName("parse: null returns ZERO")
    void parseNull() {
        assertEquals(BigDecimal.ZERO, MoneyUtils.parse(null));
    }

    @Test
    @DisplayName("parse: blank returns ZERO")
    void parseBlank() {
        assertEquals(BigDecimal.ZERO, MoneyUtils.parse("   "));
    }

    @Test
    @DisplayName("parse: empty string returns ZERO")
    void parseEmpty() {
        assertEquals(BigDecimal.ZERO, MoneyUtils.parse(""));
    }

    @Test
    @DisplayName("parse: invalid string throws IllegalArgumentException")
    void parseInvalidThrows() {
        assertThrows(IllegalArgumentException.class, () -> MoneyUtils.parse("not-a-number"));
    }

    // --- format / parse roundtrip --------------------------------------------

    @Test
    @DisplayName("format/parse roundtrip: positive")
    void roundtripPositive() {
        BigDecimal original = new BigDecimal("555.55");
        String formatted = MoneyUtils.format(original);
        BigDecimal parsed = MoneyUtils.parse(formatted);
        assertEquals(original, parsed);
    }

    @Test
    @DisplayName("format/parse roundtrip: zero")
    void roundtripZero() {
        BigDecimal original = BigDecimal.ZERO;
        String formatted = MoneyUtils.format(original);
        BigDecimal parsed = MoneyUtils.parse(formatted);
        assertEquals(new BigDecimal("0.00"), parsed);
    }

    @Test
    @DisplayName("format/parse roundtrip: negative")
    void roundtripNegative() {
        BigDecimal original = new BigDecimal("-2000.00");
        String formatted = MoneyUtils.format(original);
        BigDecimal parsed = MoneyUtils.parse(formatted);
        assertEquals(original, parsed);
    }

    @Test
    @DisplayName("format/parse roundtrip: value with cents")
    void roundtripWithCents() {
        BigDecimal original = new BigDecimal("3.75");
        String formatted = MoneyUtils.format(original);
        assertEquals("$3.75", formatted);
        BigDecimal parsed = MoneyUtils.parse(formatted);
        assertEquals(original, parsed);
    }

    // --- createLargeDataset helper -------------------------------------------

    @Test
    @DisplayName("createLargeDataset: correct count")
    void createLargeDatasetCount() {
        List<LedgerEntry> entries = MoneyUtilsTest.createLargeDataset(1000);
        assertEquals(1000, entries.size());
    }

    @Test
    @DisplayName("createLargeDataset: entries are valid")
    void createLargeDatasetEntriesValid() {
        List<LedgerEntry> entries = MoneyUtilsTest.createLargeDataset(100);
        for (LedgerEntry entry : entries) {
            assertNotNull(entry.getId(), "id should not be null");
            assertNotNull(entry.getDate(), "date should not be null");
            assertNotNull(entry.getDescription(), "description should not be null");
            assertNotNull(entry.getAmount(), "amount should not be null");
            assertNotNull(entry.getCategory(), "category should not be null");
        }
    }

    @Test
    @DisplayName("createLargeDataset: each category populated evenly")
    void createLargeDatasetCategories() {
        int count = 500;
        List<LedgerEntry> entries = MoneyUtilsTest.createLargeDataset(count);
        long countFood = entries.stream().filter(e -> e.getCategory().equals("food")).count();
        long countTransport = entries.stream().filter(e -> e.getCategory().equals("transport")).count();
        long countEntertainment = entries.stream().filter(e -> e.getCategory().equals("entertainment")).count();
        long countUtilities = entries.stream().filter(e -> e.getCategory().equals("utilities")).count();
        long countShopping = entries.stream().filter(e -> e.getCategory().equals("shopping")).count();
        int perCategory = count / 5;
        // Allow some slack for any division rounding
        assertTrue(Math.abs(countFood - perCategory) <= 1, "food count off: " + countFood);
        assertTrue(Math.abs(countTransport - perCategory) <= 1, "transport count off: " + countTransport);
        assertTrue(Math.abs(countEntertainment - perCategory) <= 1, "entertainment count off: " + countEntertainment);
        assertTrue(Math.abs(countUtilities - perCategory) <= 1, "utilities count off: " + countUtilities);
        assertTrue(Math.abs(countShopping - perCategory) <= 1, "shopping count off: " + countShopping);
    }

    /**
     * Creates a dataset of {@code count} LedgerEntry objects for use in
     * performance / load tests. Entries are evenly distributed across
     * 5 categories: food, transport, entertainment, utilities, shopping.
     * Amounts cycle through a set of 5 fixed values.
     * Dates start at 2025-01-01 and increment by one day per entry.
     *
     * @param count number of entries to generate
     * @return list of generated entries (modifiable)
     */
    static List<LedgerEntry> createLargeDataset(int count) {
        String[] categories = {"food", "transport", "entertainment", "utilities", "shopping"};
        BigDecimal[] amounts = {
                new BigDecimal("42.50"),
                new BigDecimal("17.75"),
                new BigDecimal("99.99"),
                new BigDecimal("5.00"),
                new BigDecimal("210.00")
        };
        java.time.LocalDate startDate = java.time.LocalDate.of(2025, 1, 1);
        java.util.List<LedgerEntry> entries = new java.util.ArrayList<>(count);
        for (int i = 0; i < count; i++) {
            entries.add(LedgerEntry.create(
                    startDate.plusDays(i),
                    "Entry " + (i + 1),
                    amounts[i % amounts.length],
                    categories[i % categories.length]
            ));
        }
        return entries;
    }
}
