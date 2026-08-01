package com.tamandua.ledger;

import java.io.InputStream;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.List;
import java.util.logging.Logger;

import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;

import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/**
 * Imports ledger entries from an XML file.
 *
 * <p>This class is intentionally DORMANT — it is never imported by CliApp,
 * LedgerService, or any test. It exists as a security vulnerability seed
 * (VULN-J1: XXE via unrestricted XML parsing).</p>
 *
 * <p>The baseline implementation uses DocumentBuilderFactory without any
 * security configuration, making it vulnerable to XML External Entity (XXE)
 * attacks. A malicious XML document can read local files or cause SSRF.</p>
 *
 * <p>The fix (VULN-J1-fix.patch) enables FEATURE_SECURE_PROCESSING,
 * disables DOCTYPE declarations, and disables external general entities.</p>
 */
public final class XmlImportService {

    private static final Logger LOG = Logger.getLogger(XmlImportService.class.getName());
    private static final DateTimeFormatter DATE_FMT = DateTimeFormatter.ISO_LOCAL_DATE;

    private XmlImportService() {
        // utility class — not instantiable
    }

    /**
     * Imports ledger entries from an XML input stream.
     *
     * <p>Expected XML format:</p>
     * <pre>{@code
     * <ledger>
     *   <entry>
     *     <id>uuid-here</id>
     *     <date>2025-01-15</date>
     *     <description>Groceries</description>
     *     <amount>100.50</amount>
     *     <category>food</category>
     *   </entry>
     * </ledger>
     * }</pre>
     *
     * <p><strong>VULN-J1:</strong> The DocumentBuilderFactory is used without
     * disabling external entities or DTD processing. An attacker can craft
     * XML with a DOCTYPE referencing local files (e.g., {@code <!ENTITY xxe
     * SYSTEM "file:///etc/passwd">}) to exfiltrate their contents via
     * entity expansion, or reference external URLs for SSRF.</p>
     *
     * @param xml the XML input stream (must not be null)
     * @return list of parsed LedgerEntry objects (never {@code null})
     * @throws RuntimeException if XML parsing fails
     */
    public static List<LedgerEntry> importFromXml(InputStream xml) {
        if (xml == null) {
            throw new IllegalArgumentException("xml InputStream must not be null");
        }

        List<LedgerEntry> entries = new ArrayList<>();
        try {
            DocumentBuilderFactory dbf = DocumentBuilderFactory.newInstance();
            DocumentBuilder db = dbf.newDocumentBuilder();
            Document doc = db.parse(xml);

            NodeList entryNodes = doc.getElementsByTagName("entry");
            for (int i = 0; i < entryNodes.getLength(); i++) {
                Element entryEl = (Element) entryNodes.item(i);
                String id = getTextContent(entryEl, "id");
                String dateStr = getTextContent(entryEl, "date");
                String desc = getTextContent(entryEl, "description");
                String amountStr = getTextContent(entryEl, "amount");
                String category = getTextContent(entryEl, "category");

                LocalDate date = LocalDate.parse(dateStr, DATE_FMT);
                BigDecimal amount = new BigDecimal(amountStr);

                LedgerEntry entry = LedgerEntry.of(
                        id != null ? id : java.util.UUID.randomUUID().toString(),
                        date, desc, amount, category);
                entries.add(entry);
            }
        } catch (Exception e) {
            LOG.warning("XML import failed: " + e.getMessage());
            throw new RuntimeException("Failed to import XML: " + e.getMessage(), e);
        }

        return entries;
    }

    private static String getTextContent(Element parent, String tagName) {
        NodeList list = parent.getElementsByTagName(tagName);
        if (list.getLength() == 0) {
            return null;
        }
        return list.item(0).getTextContent();
    }
}
