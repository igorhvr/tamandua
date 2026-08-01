package com.tamandua.ledger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Integration tests for {@link CliApp}.
 */
class CliAppTest {

    private Path csvFile;

    @BeforeEach
    void setUp() throws Exception {
        csvFile = Files.createTempFile("ledger-test-", ".csv");
        Files.writeString(csvFile,
                "id,date,description,amount,category\n"
                        + "id-1,2025-01-10,Groceries,100.00,food\n"
                        + "id-2,2025-01-11,Restaurant,50.00,food\n"
                        + "id-3,2025-02-01,Bus pass,75.00,transport\n"
                        + "id-4,2025-03-15,Movie,150.00,entertainment\n"
                        + "id-5,2025-01-12,Snacks,25.00,food\n"
                        + "id-6,2025-01-31,Train,75.00,transport\n");
    }

    @AfterEach
    void tearDown() throws Exception {
        Files.deleteIfExists(csvFile);
    }

    // --- helpers -------------------------------------------------------------

    /**
     * Runs the CLI with captured stdout/stderr and returns the outputs + exit code.
     */
    static CliResult runCli(String... args) {
        ByteArrayOutputStream outBytes = new ByteArrayOutputStream();
        ByteArrayOutputStream errBytes = new ByteArrayOutputStream();
        PrintStream out = new PrintStream(outBytes);
        PrintStream err = new PrintStream(errBytes);
        int exitCode = CliApp.run(args, out, err);
        out.flush();
        err.flush();
        return new CliResult(exitCode, outBytes.toString(), errBytes.toString());
    }

    record CliResult(int exitCode, String stdout, String stderr) {
    }

    // --- summary subcommand --------------------------------------------------

    @Test
    @DisplayName("summary: prints total count and formatted total")
    void summaryPrintsTotalAndTotal() {
        CliResult result = runCli("summary", csvFile.toString());
        assertEquals(0, result.exitCode());
        assertTrue(result.stdout().contains("Total entries: 6"));
        assertTrue(result.stdout().contains("Total: $475.00"));
    }

    @Test
    @DisplayName("summary: prints category breakdown sorted alphabetically")
    void summaryPrintsCategoryBreakdown() {
        CliResult result = runCli("summary", csvFile.toString());
        assertTrue(result.stdout().contains("Category breakdown:"));
        // Categories sorted alphabetically: entertainment, food, transport
        int entIdx = result.stdout().indexOf("entertainment");
        int foodIdx = result.stdout().indexOf("food");
        int transIdx = result.stdout().indexOf("transport");
        assertTrue(entIdx < foodIdx, "entertainment should come before food");
        assertTrue(foodIdx < transIdx, "food should come before transport");
        // Check totals
        assertTrue(result.stdout().contains("entertainment: $150.00"));
        assertTrue(result.stdout().contains("food: $175.00"));
        assertTrue(result.stdout().contains("transport: $150.00"));
    }

    @Test
    @DisplayName("summary: includes '$' in formatted total")
    void summaryIncludesDollarSign() {
        CliResult result = runCli("summary", csvFile.toString());
        assertTrue(result.stdout().contains("$475.00"));
    }

    // --- filter --category subcommand ----------------------------------------

    @Test
    @DisplayName("filter --category: prints only matching entries")
    void filterByCategoryPrintsMatchingEntries() {
        CliResult result = runCli("filter", csvFile.toString(), "--category", "food");
        assertEquals(0, result.exitCode());
        // Should have 3 food entries
        assertTrue(result.stdout().contains("Groceries"));
        assertTrue(result.stdout().contains("Restaurant"));
        assertTrue(result.stdout().contains("Snacks"));
        // Should NOT contain non-food entries
        assertTrue(!result.stdout().contains("Bus pass"));
        assertTrue(!result.stdout().contains("Movie"));
    }

    @Test
    @DisplayName("filter --category: prints total for matching entries")
    void filterByCategoryPrintsTotal() {
        CliResult result = runCli("filter", csvFile.toString(), "--category", "food");
        // 100 + 50 + 25 = 175
        assertTrue(result.stdout().contains("Total: $175.00"));
    }

    @Test
    @DisplayName("filter --category: case-insensitive match")
    void filterByCategoryCaseInsensitive() {
        CliResult result = runCli("filter", csvFile.toString(), "--category", "FOOD");
        assertEquals(0, result.exitCode());
        assertTrue(result.stdout().contains("Groceries"));
        assertTrue(result.stdout().contains("Total: $175.00"));
    }

    @Test
    @DisplayName("filter --category: no matches shows message")
    void filterByCategoryNoMatches() {
        CliResult result = runCli("filter", csvFile.toString(), "--category", "nonexistent");
        assertEquals(0, result.exitCode());
        assertTrue(result.stdout().contains("No entries found for category: nonexistent"));
        assertTrue(result.stdout().contains("Total: $0.00"));
    }

    // --- filter --start/--end subcommand -------------------------------------

    @Test
    @DisplayName("filter --start/--end: prints entries in date range")
    void filterByDateRangePrintsEntriesInRange() {
        CliResult result = runCli("filter", csvFile.toString(),
                "--start", "2025-01-10", "--end", "2025-01-12");
        assertEquals(0, result.exitCode());
        // id-1 (2025-01-10), id-2 (2025-01-11), id-5 (2025-01-12)
        assertTrue(result.stdout().contains("Groceries"));
        assertTrue(result.stdout().contains("Restaurant"));
        assertTrue(result.stdout().contains("Snacks"));
        assertTrue(!result.stdout().contains("Bus pass"));
        assertTrue(!result.stdout().contains("Train"));
    }

    @Test
    @DisplayName("filter --start/--end: prints total for filtered entries")
    void filterByDateRangePrintsTotal() {
        CliResult result = runCli("filter", csvFile.toString(),
                "--start", "2025-01-10", "--end", "2025-01-12");
        // 100 + 50 + 25 = 175
        assertTrue(result.stdout().contains("Total: $175.00"));
    }

    @Test
    @DisplayName("filter --start/--end: inclusive of boundary dates")
    void filterByDateRangeInclusive() {
        CliResult result = runCli("filter", csvFile.toString(),
                "--start", "2025-03-15", "--end", "2025-03-15");
        assertEquals(0, result.exitCode());
        assertTrue(result.stdout().contains("Movie"));
        assertTrue(result.stdout().contains("Total: $150.00"));
    }

    @Test
    @DisplayName("filter --start/--end: no matches shows message")
    void filterByDateRangeNoMatches() {
        CliResult result = runCli("filter", csvFile.toString(),
                "--start", "2024-01-01", "--end", "2024-12-31");
        assertEquals(0, result.exitCode());
        assertTrue(result.stdout().contains("No entries found in date range"));
        assertTrue(result.stdout().contains("Total: $0.00"));
    }

    @Test
    @DisplayName("filter --start/--end: invalid date format produces error")
    void filterByDateRangeInvalidDate() {
        CliResult result = runCli("filter", csvFile.toString(),
                "--start", "not-a-date", "--end", "2025-12-31");
        assertEquals(1, result.exitCode());
        assertTrue(result.stderr().contains("Invalid date format"));
    }

    // --- list subcommand -----------------------------------------------------

    @Test
    @DisplayName("list: prints all entries sorted by date")
    void listPrintsEntriesSortedByDate() {
        CliResult result = runCli("list", csvFile.toString());
        assertEquals(0, result.exitCode());

        String[] lines = result.stdout().split("\n");
        // Verify dates are in ascending order
        int idx1 = result.stdout().indexOf("2025-01-10");
        int idx2 = result.stdout().indexOf("2025-01-11");
        int idx5 = result.stdout().indexOf("2025-01-12");
        int idx6 = result.stdout().indexOf("2025-01-31");
        int idx3 = result.stdout().indexOf("2025-02-01");
        int idx4 = result.stdout().indexOf("2025-03-15");

        assertTrue(idx1 < idx2 && idx2 < idx5 && idx5 < idx6
                && idx6 < idx3 && idx3 < idx4,
                "entries should be sorted by date ascending");
    }

    @Test
    @DisplayName("list: prints entry in correct format")
    void listPrintsCorrectFormat() {
        CliResult result = runCli("list", csvFile.toString());
        // First entry should be: 2025-01-10 | Groceries | $100.00 | food
        String line = result.stdout().split("\n")[0];
        assertTrue(line.contains("2025-01-10"));
        assertTrue(line.contains("Groceries"));
        assertTrue(line.contains("$100.00"));
        assertTrue(line.contains("food"));
    }

    @Test
    @DisplayName("list: prints all entries")
    void listPrintsAllEntries() {
        CliResult result = runCli("list", csvFile.toString());
        long lineCount = result.stdout().lines().count();
        assertEquals(6, lineCount);
    }

    // --- error handling ------------------------------------------------------

    @Test
    @DisplayName("file not found: exits with code 1 and error to stderr")
    void fileNotFoundExitsWithError() {
        CliResult result = runCli("summary", "/nonexistent/path/ledger.csv");
        assertEquals(1, result.exitCode());
        assertTrue(result.stderr().contains("Error: File not found"));
    }

    @Test
    @DisplayName("missing subcommand: prints usage and exits with code 1")
    void missingSubcommandExitsWithError() {
        CliResult result = runCli(csvFile.toString());
        assertEquals(1, result.exitCode());
        assertTrue(result.stderr().contains("Error: Missing subcommand"));
    }

    @Test
    @DisplayName("unknown subcommand: prints error and exits with code 1")
    void unknownSubcommandExitsWithError() {
        CliResult result = runCli("unknown", csvFile.toString());
        assertEquals(1, result.exitCode());
        assertTrue(result.stderr().contains("Error: Unknown subcommand"));
    }

    @Test
    @DisplayName("empty arguments: exits with code 1")
    void emptyArgumentsExitsWithError() {
        CliResult result = runCli();
        assertEquals(1, result.exitCode());
        assertTrue(result.stderr().contains("Error: Missing subcommand"));
    }

    @Test
    @DisplayName("filter without options: prints usage and exits with code 1")
    void filterWithoutOptionsExitsWithError() {
        CliResult result = runCli("filter", csvFile.toString());
        assertEquals(1, result.exitCode());
        assertTrue(result.stderr().contains("Invalid filter options"));
    }

    // --- output format verification ------------------------------------------

    @Test
    @DisplayName("entry output format: {date} | {description} | {amount} | {category}")
    void entryOutputFormat() {
        CliResult result = runCli("list", csvFile.toString());
        String firstLine = result.stdout().lines().findFirst().orElse("");
        // 2025-01-10 | Groceries | $100.00 | food
        String[] parts = firstLine.split(" \\| ");
        assertEquals(4, parts.length);
        assertEquals("2025-01-10", parts[0]);
        assertEquals("Groceries", parts[1]);
        assertEquals("$100.00", parts[2]);
        assertEquals("food", parts[3]);
    }

    // --- end-to-end smoke test -----------------------------------------------

    @Test
    @DisplayName("end-to-end: parse CSV, run through all service methods, verify results")
    void endToEndSmokeTest() throws Exception {
        // Create a temp CSV with known data
        String csvContent = "id,date,description,amount,category\n"
                + "smoke-1,2025-06-01,Coffee,5.50,food\n"
                + "smoke-2,2025-06-02,Bus ticket,3.25,transport\n"
                + "smoke-3,2025-06-03,Coffee,5.50,food\n"
                + "smoke-4,2025-06-04,Movie,12.00,entertainment\n"
                + "smoke-5,2025-06-05,Sandwich,8.75,food\n";

        Path smokeFile = Files.createTempFile("smoke-", ".csv");
        try {
            Files.writeString(smokeFile, csvContent);

            // Parse and verify
            List<LedgerEntry> entries = CsvParser.parse(smokeFile);
            assertEquals(5, entries.size());

            // Verify getTotal
            BigDecimal total = LedgerService.getTotal(entries);
            // 5.50 + 3.25 + 5.50 + 12.00 + 8.75 = 35.00
            assertEquals(new BigDecimal("35.00"), total);

            // Verify getByCategory
            List<LedgerEntry> foodEntries = LedgerService.getByCategory(entries, "food");
            assertEquals(3, foodEntries.size());

            // Verify getByDateRange
            List<LedgerEntry> juneEntries = LedgerService.getByDateRange(entries,
                    java.time.LocalDate.of(2025, 6, 2),
                    java.time.LocalDate.of(2025, 6, 4));
            assertEquals(3, juneEntries.size());

            // Verify getCategoryTotals
            Map<String, BigDecimal> categoryTotals = LedgerService.getCategoryTotals(entries);
            assertEquals(new BigDecimal("19.75"), categoryTotals.get("food"));
            assertEquals(new BigDecimal("3.25"), categoryTotals.get("transport"));
            assertEquals(new BigDecimal("12.00"), categoryTotals.get("entertainment"));

            // Verify getSortedByAmount
            List<LedgerEntry> sorted = LedgerService.getSortedByAmount(entries);
            assertEquals(5, sorted.size());
            // First should be the smallest: 3.25 (Bus ticket)
            assertEquals("Bus ticket", sorted.get(0).getDescription());
            // Last should be the largest: 12.00 (Movie)
            assertEquals("Movie", sorted.get(sorted.size() - 1).getDescription());

            // Verify CLI summary
            CliResult result = runCli("summary", smokeFile.toString());
            assertEquals(0, result.exitCode());
            assertTrue(result.stdout().contains("Total entries: 5"));
            assertTrue(result.stdout().contains("Total: $35.00"));
            assertTrue(result.stdout().contains("entertainment: $12.00"));
            assertTrue(result.stdout().contains("food: $19.75"));
            assertTrue(result.stdout().contains("transport: $3.25"));

            // Verify CLI list
            CliResult listResult = runCli("list", smokeFile.toString());
            assertEquals(0, result.exitCode());
            assertTrue(listResult.stdout().contains("Coffee"));
            assertTrue(listResult.stdout().contains("Sandwich"));

        } finally {
            Files.deleteIfExists(smokeFile);
        }
    }
}
