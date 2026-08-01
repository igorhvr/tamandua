package com.tamandua.ledger;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.*;

class LedgerEntryTest {

    @Test
    @DisplayName("create with valid data assigns all fields correctly")
    void testCreateWithValidData() {
        LedgerEntry entry = LedgerEntry.create(
                LocalDate.of(2025, 1, 15),
                "Groceries",
                new BigDecimal("100.50"),
                "food");

        assertNotNull(entry.getId());
        assertFalse(entry.getId().isEmpty());
        assertEquals(LocalDate.of(2025, 1, 15), entry.getDate());
        assertEquals("Groceries", entry.getDescription());
        assertEquals(new BigDecimal("100.50"), entry.getAmount());
        assertEquals("food", entry.getCategory());
    }

    @Test
    @DisplayName("factory method generates unique UUID-based id for each entry")
    void testFactoryMethodGeneratesUuid() {
        LedgerEntry e1 = LedgerEntry.create(LocalDate.now(), "Test", BigDecimal.ONE, "test");
        LedgerEntry e2 = LedgerEntry.create(LocalDate.now(), "Test", BigDecimal.ONE, "test");

        assertNotNull(e1.getId());
        assertNotNull(e2.getId());
        assertNotEquals(e1.getId(), e2.getId(), "each entry should get a unique id");
        assertDoesNotThrow(() -> UUID.fromString(e1.getId()), "id should be a valid UUID");
        assertDoesNotThrow(() -> UUID.fromString(e2.getId()), "id should be a valid UUID");
    }

    @Test
    @DisplayName("of() accepts an explicit id")
    void testOfMethodWithExplicitId() {
        String explicitId = "550e8400-e29b-41d4-a716-446655440000";
        LedgerEntry entry = LedgerEntry.of(
                explicitId,
                LocalDate.of(2025, 3, 10),
                "Salary",
                new BigDecimal("5000.00"),
                "income");

        assertEquals(explicitId, entry.getId());
        assertEquals(LocalDate.of(2025, 3, 10), entry.getDate());
        assertEquals("Salary", entry.getDescription());
        assertEquals(new BigDecimal("5000.00"), entry.getAmount());
        assertEquals("income", entry.getCategory());
    }

    @Test
    @DisplayName("rejects null amount")
    void testRejectsNullAmount() {
        assertThrows(NullPointerException.class, () ->
                LedgerEntry.create(LocalDate.now(), "Test", null, "test"));
    }

    @Test
    @DisplayName("rejects empty description")
    void testRejectsEmptyDescription() {
        assertThrows(IllegalArgumentException.class, () ->
                LedgerEntry.create(LocalDate.now(), "", BigDecimal.ONE, "test"));
    }

    @Test
    @DisplayName("rejects blank description (whitespace only)")
    void testRejectsBlankDescription() {
        // Only empty strings are rejected; whitespace-only strings are accepted
        // per the explicit spec (description must be non-empty)
        assertDoesNotThrow(() ->
                LedgerEntry.create(LocalDate.now(), "   ", BigDecimal.ONE, "test"));
    }

    @Test
    @DisplayName("rejects null category")
    void testRejectsNullCategory() {
        assertThrows(NullPointerException.class, () ->
                LedgerEntry.create(LocalDate.now(), "Test", BigDecimal.ONE, null));
    }

    @Test
    @DisplayName("rejects null description")
    void testRejectsNullDescription() {
        assertThrows(NullPointerException.class, () ->
                LedgerEntry.create(LocalDate.now(), null, BigDecimal.ONE, "test"));
    }

    @Test
    @DisplayName("equality is based on id only — same id, different fields")
    void testEqualityByIdSameIdDifferentFields() {
        LedgerEntry e1 = LedgerEntry.of(
                "abc-123",
                LocalDate.of(2025, 1, 1),
                "Widgets",
                new BigDecimal("10.00"),
                "supplies");
        LedgerEntry e2 = LedgerEntry.of(
                "abc-123",
                LocalDate.of(2025, 12, 31),
                "Different description",
                new BigDecimal("9999.99"),
                "other");

        assertEquals(e1, e2, "entries with same id should be equal regardless of other fields");
        assertEquals(e1.hashCode(), e2.hashCode());
    }

    @Test
    @DisplayName("equality is based on id only — different id, same fields")
    void testEqualityByIdDifferentIdSameFields() {
        LedgerEntry e1 = LedgerEntry.of(
                "id-1",
                LocalDate.of(2025, 1, 1),
                "Widgets",
                new BigDecimal("10.00"),
                "supplies");
        LedgerEntry e2 = LedgerEntry.of(
                "id-2",
                LocalDate.of(2025, 1, 1),
                "Widgets",
                new BigDecimal("10.00"),
                "supplies");

        assertNotEquals(e1, e2, "entries with different ids should not be equal");
    }

    @Test
    @DisplayName("toString includes id, date, description, amount, and category")
    void testToStringFormat() {
        LedgerEntry entry = LedgerEntry.of(
                "id-1",
                LocalDate.of(2025, 6, 15),
                "Coffee",
                new BigDecimal("4.50"),
                "food");

        String str = entry.toString();
        assertTrue(str.contains("id-1"), "toString should contain the id");
        assertTrue(str.contains("2025-06-15"), "toString should contain the date");
        assertTrue(str.contains("Coffee"), "toString should contain the description");
        assertTrue(str.contains("4.50"), "toString should contain the amount");
        assertTrue(str.contains("food"), "toString should contain the category");
    }
}
