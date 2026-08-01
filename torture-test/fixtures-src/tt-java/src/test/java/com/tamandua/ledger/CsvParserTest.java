package com.tamandua.ledger;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;

import static org.junit.jupiter.api.Assertions.*;

class CsvParserTest {

    private Path tempFile;

    @BeforeEach
    void setUp() throws IOException {
        tempFile = Files.createTempFile("csv-test-", ".csv");
    }

    @AfterEach
    void tearDown() throws IOException {
        Files.deleteIfExists(tempFile);
    }

    @Test
    @DisplayName("parses valid CSV with all fields correctly")
    void testParseValidCsv() throws IOException {
        String csv = """
                id,date,description,amount,category
                abc-001,2025-01-15,Groceries,100.50,food
                abc-002,2025-01-16,Salary,5000.00,income
                """;
        Files.writeString(tempFile, csv);

        List<LedgerEntry> entries = CsvParser.parse(tempFile);

        assertEquals(2, entries.size());
        assertEquals("abc-001", entries.get(0).getId());
        assertEquals(LocalDate.of(2025, 1, 15), entries.get(0).getDate());
        assertEquals("Groceries", entries.get(0).getDescription());
        assertEquals(new BigDecimal("100.50"), entries.get(0).getAmount());
        assertEquals("food", entries.get(0).getCategory());

        assertEquals("abc-002", entries.get(1).getId());
        assertEquals(LocalDate.of(2025, 1, 16), entries.get(1).getDate());
        assertEquals("Salary", entries.get(1).getDescription());
        assertEquals(new BigDecimal("5000.00"), entries.get(1).getAmount());
        assertEquals("income", entries.get(1).getCategory());
    }

    @Test
    @DisplayName("empty CSV returns empty list, not null")
    void testEmptyCsvReturnsEmptyList() throws IOException {
        Files.writeString(tempFile, "");

        List<LedgerEntry> entries = CsvParser.parse(tempFile);

        assertNotNull(entries, "should not return null");
        assertTrue(entries.isEmpty(), "should return empty list");
    }

    @Test
    @DisplayName("CSV with only header and no data rows returns empty list")
    void testHeaderOnlyReturnsEmptyList() throws IOException {
        Files.writeString(tempFile, "id,date,description,amount,category\n");

        List<LedgerEntry> entries = CsvParser.parse(tempFile);

        assertNotNull(entries);
        assertTrue(entries.isEmpty());
    }

    @Test
    @DisplayName("skips empty lines and comment lines starting with #")
    void testSkipCommentsAndEmptyLines() throws IOException {
        String csv = """
                # This is a comment
                id,date,description,amount,category
                # Another comment
                abc-001,2025-01-15,Groceries,100.50,food

                abc-002,2025-01-16,Salary,5000.00,income
                # trailing comment
                """;
        Files.writeString(tempFile, csv);

        List<LedgerEntry> entries = CsvParser.parse(tempFile);

        assertEquals(2, entries.size());
        assertEquals("Groceries", entries.get(0).getDescription());
        assertEquals("Salary", entries.get(1).getDescription());
    }

    @Test
    @DisplayName("handles quoted fields with embedded commas")
    void testQuotedFieldsWithCommas() throws IOException {
        String csv = """
                id,date,description,amount,category
                abc-001,2025-01-15,"Grocery, fresh produce and snacks",100.50,food
                abc-002,2025-02-01,"Rent, January 2025",2000.00,housing
                """;
        Files.writeString(tempFile, csv);

        List<LedgerEntry> entries = CsvParser.parse(tempFile);

        assertEquals(2, entries.size());
        assertEquals("Grocery, fresh produce and snacks", entries.get(0).getDescription());
        assertEquals("Rent, January 2025", entries.get(1).getDescription());
    }

    @Test
    @DisplayName("skips malformed rows and logs warning, continues parsing remaining rows")
    void testMalformedRowsSkippedWithWarning() throws IOException {
        Logger logger = Logger.getLogger(CsvParser.class.getName());
        TestLogHandler handler = new TestLogHandler();
        handler.setLevel(Level.WARNING);
        logger.addHandler(handler);

        try {
            String csv = """
                    id,date,description,amount,category
                    abc-001,2025-01-15,Groceries,100.50,food
                    bad-row-only-three-fields
                    abc-002,2025-01-16,Salary,not-a-number,income
                    abc-003,2025-01-17,Coffee,4.50,beverages
                    """;
            Files.writeString(tempFile, csv);

            List<LedgerEntry> entries = CsvParser.parse(tempFile);

            assertEquals(2, entries.size(), "only valid rows should be parsed");
            assertEquals("Groceries", entries.get(0).getDescription());
            assertEquals("Coffee", entries.get(1).getDescription());

            // Verify warnings were logged for malformed rows
            assertTrue(handler.getMessages().size() >= 2,
                    "expected at least 2 warning messages, got " + handler.getMessages().size());
        } finally {
            logger.removeHandler(handler);
        }
    }

    @Test
    @DisplayName("missing header — logs warning, returns empty list")
    void testMissingHeader() throws IOException {
        Logger logger = Logger.getLogger(CsvParser.class.getName());
        TestLogHandler handler = new TestLogHandler();
        handler.setLevel(Level.WARNING);
        logger.addHandler(handler);

        try {
            String csv = """
                    abc-001,2025-01-15,Groceries,100.50,food
                    abc-002,2025-01-16,Salary,5000.00,income
                    """;
            Files.writeString(tempFile, csv);

            List<LedgerEntry> entries = CsvParser.parse(tempFile);

            assertNotNull(entries);
            assertTrue(entries.isEmpty(), "should return empty list when header is missing");
            assertFalse(handler.getMessages().isEmpty(), "should log warning about missing header");
        } finally {
            logger.removeHandler(handler);
        }
    }

    @Test
    @DisplayName("trims extra whitespace in fields")
    void testExtraWhitespaceTrimmed() throws IOException {
        String csv = """
                id,date,description,amount,category
                 abc-001 , 2025-01-15 ,  Grocery  ,  100.50 ,  food
                """;
        Files.writeString(tempFile, csv);

        List<LedgerEntry> entries = CsvParser.parse(tempFile);

        assertEquals(1, entries.size());
        assertEquals("abc-001", entries.get(0).getId());
        assertEquals(LocalDate.of(2025, 1, 15), entries.get(0).getDate());
        assertEquals("Grocery", entries.get(0).getDescription());
        assertEquals(new BigDecimal("100.50"), entries.get(0).getAmount());
        assertEquals("food", entries.get(0).getCategory());
    }

    @Test
    @DisplayName("amount parsing uses BigDecimal for monetary precision")
    void testAmountUsesBigDecimal() throws IOException {
        String csv = """
                id,date,description,amount,category
                abc-001,2025-01-15,Widget,0.10,food
                abc-002,2025-01-16,Gadget,0.20,food
                """;
        Files.writeString(tempFile, csv);

        List<LedgerEntry> entries = CsvParser.parse(tempFile);

        assertEquals(2, entries.size());
        // 0.1 + 0.2 should be exactly 0.3 with BigDecimal (not 0.30000000000000004)
        BigDecimal sum = entries.get(0).getAmount().add(entries.get(1).getAmount());
        assertEquals(new BigDecimal("0.30"), sum, "BigDecimal should preserve exact decimal arithmetic");
    }

    @Test
    @DisplayName("handles escaped quotes inside quoted fields")
    void testEscapedQuotesInFields() throws IOException {
        String csv = """
                id,date,description,amount,category
                abc-001,2025-01-15,"Item with ""quoted"" text",50.00,other
                """;
        Files.writeString(tempFile, csv);

        List<LedgerEntry> entries = CsvParser.parse(tempFile);

        assertEquals(1, entries.size());
        assertEquals("Item with \"quoted\" text", entries.get(0).getDescription());
    }

    @Test
    @DisplayName("CSV file with only comments and empty lines returns empty list")
    void testOnlyCommentsReturnsEmptyList() throws IOException {
        String csv = """
                # comment one
                # comment two

                # another comment
                """;
        Files.writeString(tempFile, csv);

        List<LedgerEntry> entries = CsvParser.parse(tempFile);

        assertNotNull(entries);
        assertTrue(entries.isEmpty());
    }

    /**
     * A simple log handler that captures messages for test assertions.
     */
    static class TestLogHandler extends java.util.logging.Handler {

        private final List<String> messages = new java.util.ArrayList<>();

        @Override
        public void publish(java.util.logging.LogRecord record) {
            if (isLoggable(record)) {
                messages.add(record.getMessage());
            }
        }

        @Override
        public void flush() {
        }

        @Override
        public void close() throws SecurityException {
        }

        List<String> getMessages() {
            return messages;
        }
    }
}
