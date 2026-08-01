package com.tamandua.ledger;

import java.io.IOException;
import java.io.PrintStream;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.Comparator;
import java.util.List;
import java.util.Map;

/**
 * CLI entry point for the CSV ledger application.
 *
 * <p>Subcommands:</p>
 * <ul>
 *   <li>{@code summary <csv-file>} — total count, total amount, category breakdown</li>
 *   <li>{@code filter <csv-file> --category <name>} — entries matching category</li>
 *   <li>{@code filter <csv-file> --start <date> --end <date>} — entries in date range</li>
 *   <li>{@code list <csv-file>} — all entries sorted by date</li>
 * </ul>
 */
public final class CliApp {

    private CliApp() {
        // utility class
    }

    /**
     * Entry point. Delegates to {@link #run(String[], PrintStream, PrintStream)}.
     */
    public static void main(String[] args) {
        int code = run(args, System.out, System.err);
        if (code != 0) {
            System.exit(code);
        }
    }

    /**
     * Executes the CLI and returns an exit code. Designed to be testable
     * with injected output streams.
     *
     * @param args command-line arguments
     * @param out  standard output stream
     * @param err  standard error stream
     * @return 0 on success, 1 on error
     */
    public static int run(String[] args, PrintStream out, PrintStream err) {
        if (args.length < 2) {
            err.println("Error: Missing subcommand or CSV file path.");
            err.println("Usage: <subcommand> <csv-file> [options]");
            err.println("Subcommands: summary, filter, list");
            return 1;
        }

        String subcommand = args[0];
        String filePath = args[1];
        Path csvPath = Path.of(filePath);

        if (!Files.exists(csvPath)) {
            err.println("Error: File not found: " + filePath);
            return 1;
        }

        List<LedgerEntry> entries;
        try {
            entries = CsvParser.parse(csvPath);
        } catch (IOException e) {
            err.println("Error: Could not read file: " + filePath);
            return 1;
        }

        switch (subcommand) {
            case "summary":
                return handleSummary(entries, out);
            case "filter":
                return handleFilter(entries, args, out, err);
            case "list":
                return handleList(entries, out);
            default:
                err.println("Error: Unknown subcommand: " + subcommand);
                err.println("Subcommands: summary, filter, list");
                return 1;
        }
    }

    private static int handleSummary(List<LedgerEntry> entries, PrintStream out) {
        int count = LedgerService.getCount(entries);
        BigDecimal total = LedgerService.getTotal(entries);
        Map<String, BigDecimal> categoryTotals = LedgerService.getCategoryTotals(entries);

        out.println("Total entries: " + count + " | Total: " + MoneyUtils.format(total));
        if (!categoryTotals.isEmpty()) {
            out.println();
            out.println("Category breakdown:");
            for (Map.Entry<String, BigDecimal> catEntry : categoryTotals.entrySet()) {
                out.println("  " + catEntry.getKey() + ": " + MoneyUtils.format(catEntry.getValue()));
            }
        }
        return 0;
    }

    private static int handleFilter(List<LedgerEntry> entries, String[] args, PrintStream out, PrintStream err) {
        if (args.length >= 4 && "--category".equals(args[2])) {
            return handleFilterByCategory(entries, args[3], out);
        }
        if (args.length >= 6 && "--start".equals(args[2]) && "--end".equals(args[4])) {
            return handleFilterByDateRange(entries, args[3], args[5], out, err);
        }
        err.println("Error: Invalid filter options.");
        err.println("Usage: filter <csv-file> --category <name>");
        err.println("Usage: filter <csv-file> --start <date> --end <date>");
        return 1;
    }

    private static int handleFilterByCategory(List<LedgerEntry> entries, String category, PrintStream out) {
        List<LedgerEntry> filtered = LedgerService.getByCategory(entries, category);
        if (filtered.isEmpty()) {
            out.println("No entries found for category: " + category);
        } else {
            for (LedgerEntry e : filtered) {
                out.println(formatEntry(e));
            }
        }
        out.println("Total: " + MoneyUtils.format(LedgerService.getTotal(filtered)));
        return 0;
    }

    private static int handleFilterByDateRange(List<LedgerEntry> entries, String startStr, String endStr,
                                                PrintStream out, PrintStream err) {
        LocalDate start;
        LocalDate end;
        try {
            start = LocalDate.parse(startStr);
            end = LocalDate.parse(endStr);
        } catch (Exception e) {
            err.println("Error: Invalid date format. Use YYYY-MM-DD.");
            return 1;
        }
        List<LedgerEntry> filtered = LedgerService.getByDateRange(entries, start, end);
        if (filtered.isEmpty()) {
            out.println("No entries found in date range: " + startStr + " to " + endStr);
        } else {
            for (LedgerEntry e : filtered) {
                out.println(formatEntry(e));
            }
        }
        out.println("Total: " + MoneyUtils.format(LedgerService.getTotal(filtered)));
        return 0;
    }

    private static int handleList(List<LedgerEntry> entries, PrintStream out) {
        List<LedgerEntry> sorted = entries.stream()
                .sorted(Comparator.comparing(LedgerEntry::getDate))
                .toList();
        for (LedgerEntry e : sorted) {
            out.println(formatEntry(e));
        }
        return 0;
    }

    /**
     * Formats a single entry for CLI output.
     */
    static String formatEntry(LedgerEntry e) {
        return e.getDate() + " | " + e.getDescription() + " | "
                + MoneyUtils.format(e.getAmount()) + " | " + e.getCategory();
    }
}
