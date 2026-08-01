package com.tamandua.ledger;

import java.io.BufferedReader;
import java.io.IOException;
import java.math.BigDecimal;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Parses CSV files into a list of LedgerEntry objects.
 * <p>
 * The CSV format expected is:
 * <pre>
 * id,date,description,amount,category
 * </pre>
 * Quoted fields are supported (commas inside double quotes are not treated
 * as field separators). Empty lines and comment lines (starting with '#')
 * are skipped.
 * </p>
 */
public final class CsvParser {

    private static final Logger LOG = Logger.getLogger(CsvParser.class.getName());
    private static final String EXPECTED_HEADER = "id,date,description,amount,category";

    private CsvParser() {
        // utility class
    }

    /**
     * Parses a CSV file at the given path into a list of {@link LedgerEntry}.
     *
     * @param csvPath path to the CSV file
     * @return list of parsed entries, empty if the file contains no data rows
     * @throws IOException if an I/O error occurs reading the file
     */
    public static List<LedgerEntry> parse(Path csvPath) throws IOException {
        List<String> allLines = Files.readAllLines(csvPath);
        List<String> lines = new ArrayList<>();

        // Filter out empty lines and comment lines
        for (String line : allLines) {
            String trimmed = line.trim();
            if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                continue;
            }
            lines.add(trimmed);
        }

        if (lines.isEmpty()) {
            return Collections.emptyList();
        }

        // First non-comment/non-empty line is the header
        String headerLine = lines.get(0);
        if (!headerLine.equals(EXPECTED_HEADER)) {
            LOG.warning("Missing expected header. Expected: '" + EXPECTED_HEADER
                    + "', found: '" + headerLine + "'. No entries parsed.");
            return Collections.emptyList();
        }

        List<LedgerEntry> entries = new ArrayList<>();
        for (int i = 1; i < lines.size(); i++) {
            List<String> fields = parseCsvLine(lines.get(i));
            if (fields.size() != 5) {
                LOG.warning("Skipping malformed row (expected 5 fields, got " + fields.size()
                        + "): " + lines.get(i));
                continue;
            }
            try {
                String id = fields.get(0).trim();
                LocalDate date = LocalDate.parse(fields.get(1).trim());
                String description = fields.get(2).trim();
                BigDecimal amount = new BigDecimal(fields.get(3).trim());
                String category = fields.get(4).trim();
                entries.add(LedgerEntry.of(id, date, description, amount, category));
            } catch (Exception e) {
                LOG.log(Level.WARNING, "Skipping malformed row: " + lines.get(i), e);
            }
        }

        return entries;
    }

    /**
     * Parses a single CSV line into a list of field values, respecting
     * double-quote escaping.  Fields are separated by commas outside of
     * quoted regions.  Two consecutive double quotes inside a quoted field
     * represent a literal double quote.
     */
    static List<String> parseCsvLine(String line) {
        List<String> fields = new ArrayList<>();
        StringBuilder current = new StringBuilder();
        boolean inQuotes = false;

        for (int i = 0; i < line.length(); i++) {
            char ch = line.charAt(i);
            if (inQuotes) {
                if (ch == '"') {
                    // Check for escaped quote (two double quotes)
                    if (i + 1 < line.length() && line.charAt(i + 1) == '"') {
                        current.append('"');
                        i++; // skip next char
                    } else {
                        inQuotes = false;
                    }
                } else {
                    current.append(ch);
                }
            } else {
                if (ch == '"') {
                    inQuotes = true;
                } else if (ch == ',') {
                    fields.add(current.toString());
                    current.setLength(0);
                } else {
                    current.append(ch);
                }
            }
        }
        fields.add(current.toString());
        return fields;
    }
}
