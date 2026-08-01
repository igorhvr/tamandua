package com.tamandua.ledger;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.NumberFormat;
import java.text.ParseException;
import java.util.Locale;

/**
 * Static utility methods for money arithmetic, rounding, and formatting.
 * All methods that accept {@link BigDecimal} amounts are null-safe,
 * treating null amounts as {@link BigDecimal#ZERO}.
 */
public final class MoneyUtils {

    private static final BigDecimal ZERO = BigDecimal.ZERO;
    private static final int DEFAULT_SCALE = 2;
    private static final RoundingMode DEFAULT_ROUNDING = RoundingMode.HALF_UP;
    private static final NumberFormat CURRENCY_FORMAT;

    static {
        CURRENCY_FORMAT = NumberFormat.getCurrencyInstance(Locale.US);
        CURRENCY_FORMAT.setMinimumFractionDigits(DEFAULT_SCALE);
        CURRENCY_FORMAT.setMaximumFractionDigits(DEFAULT_SCALE);
    }

    private MoneyUtils() {
        // utility class
    }

    /**
     * Null-safe addition. Returns {@code ZERO} for null operands.
     *
     * @param a first addend (nullable)
     * @param b second addend (nullable)
     * @return sum of the two values, with nulls treated as ZERO
     */
    public static BigDecimal add(BigDecimal a, BigDecimal b) {
        return nullToZero(a).add(nullToZero(b));
    }

    /**
     * Null-safe subtraction. Returns {@code ZERO} for null operands.
     *
     * @param a minuend (nullable)
     * @param b subtrahend (nullable)
     * @return difference of the two values, with nulls treated as ZERO
     */
    public static BigDecimal subtract(BigDecimal a, BigDecimal b) {
        return nullToZero(a).subtract(nullToZero(b));
    }

    /**
     * Rounds the given amount to the specified scale using the given
     * {@link RoundingMode}.  Null amount is treated as {@code ZERO}.
     *
     * @param amount value to round (nullable, ZERO when null)
     * @param scale  number of decimal places
     * @param mode   rounding mode (e.g., {@link RoundingMode#HALF_UP HALF_UP})
     * @return rounded value
     */
    public static BigDecimal round(BigDecimal amount, int scale, RoundingMode mode) {
        return nullToZero(amount).setScale(scale, mode);
    }

    /**
     * Rounds to 2 decimal places using {@link RoundingMode#HALF_UP HALF_UP}.
     * Null amount is treated as {@code ZERO}.
     *
     * @param amount value to round (nullable, ZERO when null)
     * @return value rounded to 2 decimal places with HALF_UP
     */
    public static BigDecimal round(BigDecimal amount) {
        return round(amount, DEFAULT_SCALE, DEFAULT_ROUNDING);
    }

    /**
     * Formats a {@link BigDecimal} amount as a US-locale currency string
     * (e.g., {@code "$1,234.56"}). Null amount is treated as {@code ZERO}.
     *
     * @param amount value to format (nullable, ZERO when null)
     * @return formatted currency string
     */
    public static String format(BigDecimal amount) {
        BigDecimal value = nullToZero(amount).setScale(DEFAULT_SCALE, DEFAULT_ROUNDING);
        return CURRENCY_FORMAT.format(value);
    }

    /**
     * Parses a currency string back to a {@link BigDecimal}. Accepts both
     * plain numeric strings ({@code "1234.56"}) and US-locale currency
     * strings ({@code "$1,234.56"}). Null or blank input returns
     * {@code ZERO}.
     *
     * @param amountStr string to parse (nullable, ZERO when null or blank)
     * @return parsed decimal value
     * @throws java.lang.IllegalArgumentException if the string cannot be parsed
     */
    public static BigDecimal parse(String amountStr) {
        if (amountStr == null || amountStr.isBlank()) {
            return ZERO;
        }
        String trimmed = amountStr.trim();
        // Try plain BigDecimal parse first (handles "1000.50")
        try {
            return new BigDecimal(trimmed).setScale(DEFAULT_SCALE, DEFAULT_ROUNDING);
        } catch (NumberFormatException plainEx) {
            // Try currency-format parse (handles "$1,234.56")
            try {
                Number parsed = CURRENCY_FORMAT.parse(trimmed);
                return new BigDecimal(parsed.toString())
                        .setScale(DEFAULT_SCALE, DEFAULT_ROUNDING);
            } catch (ParseException currencyEx) {
                IllegalArgumentException ex = new IllegalArgumentException(
                        "Cannot parse amount: '" + amountStr + "'");
                ex.addSuppressed(plainEx);
                ex.addSuppressed(currencyEx);
                throw ex;
            }
        }
    }

    private static BigDecimal nullToZero(BigDecimal value) {
        return value != null ? value : ZERO;
    }
}
