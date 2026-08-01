package com.tamandua.ledger;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.Objects;
import java.util.UUID;

/**
 * Immutable ledger entry representing a single financial transaction.
 * Equality is based on id only, allowing two entries with identical
 * financial data but different ids to be treated as distinct.
 */
public final class LedgerEntry {

    private final String id;
    private final LocalDate date;
    private final String description;
    private final BigDecimal amount;
    private final String category;

    private LedgerEntry(String id, LocalDate date, String description, BigDecimal amount, String category) {
        this.id = Objects.requireNonNull(id, "id must not be null");
        this.date = Objects.requireNonNull(date, "date must not be null");
        this.description = Objects.requireNonNull(description, "description must not be null");
        if (description.isEmpty()) {
            throw new IllegalArgumentException("description must not be empty");
        }
        this.amount = Objects.requireNonNull(amount, "amount must not be null");
        this.category = Objects.requireNonNull(category, "category must not be null");
    }

    /**
     * Factory method that creates a LedgerEntry with an auto-generated UUID id.
     */
    public static LedgerEntry create(LocalDate date, String description, BigDecimal amount, String category) {
        return new LedgerEntry(UUID.randomUUID().toString(), date, description, amount, category);
    }

    /**
     * Creates a LedgerEntry with an explicit id. Useful for testing and deserialization.
     */
    public static LedgerEntry of(String id, LocalDate date, String description, BigDecimal amount, String category) {
        return new LedgerEntry(id, date, description, amount, category);
    }

    public String getId() {
        return id;
    }

    public LocalDate getDate() {
        return date;
    }

    public String getDescription() {
        return description;
    }

    public BigDecimal getAmount() {
        return amount;
    }

    public String getCategory() {
        return category;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) return true;
        if (!(o instanceof LedgerEntry that)) return false;
        return id.equals(that.id);
    }

    @Override
    public int hashCode() {
        return id.hashCode();
    }

    @Override
    public String toString() {
        return "LedgerEntry{id='" + id + "', date=" + date
                + ", description='" + description + "'"
                + ", amount=" + amount
                + ", category='" + category + "'}";
    }
}
