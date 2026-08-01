package com.tamandua.ledger;

import java.io.FileWriter;
import java.io.IOException;
import java.io.PrintWriter;
import java.util.List;
import java.util.logging.Logger;

/**
 * Exports ledger entries to a file.
 *
 * <p>This class is intentionally DORMANT — it is never imported by CliApp,
 * LedgerService, or any test. It exists as a security vulnerability seed
 * (VULN-J2: path traversal in file export).</p>
 *
 * <p>The baseline implementation writes entries to a user-supplied filename
 * using {@code new FileWriter(filename)} without any path validation. A
 * path traversal attack like {@code ../../etc/passwd} can overwrite
 * arbitrary files on the system.</p>
 *
 * <p>The fix (VULN-J2-fix.patch) validates that the canonical path of the
 * target file is within an allowed export directory.</p>
 */
public final class ExportService {

    private static final Logger LOG = Logger.getLogger(ExportService.class.getName());

    private ExportService() {
        // utility class — not instantiable
    }

    /**
     * Exports ledger entries to a file.
     *
     * <p>Each entry is written as a JSON-like line for simplicity.</p>
     *
     * <p><strong>VULN-J2:</strong> The filename is used directly without
     * path validation. A caller can supply a relative path with
     * {@code ../} segments to escape the working directory and overwrite
     * arbitrary files (e.g., {@code ../../etc/passwd} or
     * {@code ../../../home/user/.bashrc}).</p>
     *
     * @param entries  the entries to export (must not be null, may be empty)
     * @param filename the target filename (may contain path traversal segments)
     * @throws IOException if writing fails
     */
    public static void exportToFile(List<LedgerEntry> entries, String filename) throws IOException {
        if (entries == null) {
            throw new IllegalArgumentException("entries must not be null");
        }
        if (filename == null) {
            throw new IllegalArgumentException("filename must not be null");
        }

        LOG.info("Exporting " + entries.size() + " entries to " + filename);

        try (PrintWriter writer = new PrintWriter(new FileWriter(filename))) {
            for (LedgerEntry e : entries) {
                writer.printf("{\"id\":\"%s\",\"date\":\"%s\",\"description\":\"%s\",\"amount\":%s,\"category\":\"%s\"}%n",
                        e.getId(), e.getDate(), e.getDescription(), e.getAmount(), e.getCategory());
            }
        }
    }
}
