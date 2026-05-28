import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const htmlPath = resolve(__dirname, "..", "dist", "www", "index.html");

let html: string;
try {
  html = readFileSync(htmlPath, "utf-8");
} catch {
  // Build hasn't run yet — tests will fail descriptively
  html = "";
}

describe("www/index.html structure", () => {
  it("exists and is not empty", () => {
    assert.ok(html.length > 0, "dist/www/index.html must exist (run npm run build first)");
  });

  it("has valid HTML5 doctype", () => {
    assert.ok(html.startsWith("<!DOCTYPE html>"), "should start with HTML5 doctype");
  });

  it("has lang attribute on html element", () => {
    assert.ok(/<html\s+lang="en"/.test(html), "html element should have lang=\"en\"");
  });

  it("has charset and viewport meta tags", () => {
    assert.ok(html.includes('charset="UTF-8"'), "should declare charset");
    assert.ok(html.includes('name="viewport"'), "should have viewport meta");
  });

  it("has title element", () => {
    assert.ok(/<title>[^<]+<\/title>/.test(html), "should have a title");
  });

  it("has a skip-to-content link", () => {
    assert.ok(/skip.*content/i.test(html), "should have skip-to-content link");
    assert.ok(/href="#main-content"/.test(html), "skip link should point to #main-content");
  });

  // Semantic HTML5 elements
  it("uses semantic header element", () => {
    assert.ok(/<header\b/.test(html), "should use <header>");
    assert.ok(/<\/header>/.test(html), "should close <header>");
  });

  it("uses semantic nav element", () => {
    assert.ok(/<nav\b/.test(html), "should use <nav>");
    assert.ok(/<\/nav>/.test(html), "should close <nav>");
  });

  it("uses semantic main element", () => {
    assert.ok(/<main\b/.test(html), "should use <main>");
    assert.ok(/<\/main>/.test(html), "should close <main>");
  });

  it("main element has id='main-content'", () => {
    assert.ok(/<main[^>]*id="main-content"/.test(html), "main should have id='main-content'");
  });

  it("uses semantic section elements", () => {
    const sectionCount = (html.match(/<section\b/g) || []).length;
    assert.ok(sectionCount >= 6, `should have at least 6 sections, got ${sectionCount}`);
  });

  it("uses semantic footer element", () => {
    assert.ok(/<footer\b/.test(html), "should use <footer>");
    assert.ok(/<\/footer>/.test(html), "should close <footer>");
  });

  // Content requirements
  it("contains the install curl command", () => {
    assert.ok(
      html.includes("raw.githubusercontent.com/igorhvr/tamandua/main/scripts/install.sh"),
      "should contain the GitHub install curl command"
    );
  });

  it("contains the hero tagline", () => {
    assert.ok(
      html.includes("Build your agent team in pi with one command."),
      "should contain the hero tagline"
    );
  });

  it("links to pi GitHub repository", () => {
    assert.ok(
      html.includes("github.com/mariozechner/pi-coding-agent"),
      "should link to pi on GitHub"
    );
  });

  // Workflow tables
  it("has Feature Development table with correct data", () => {
    assert.ok(html.includes("feature-dev"), "should reference feature-dev workflow");
    assert.ok(html.includes("feature-dev-merge"), "should reference feature-dev-merge");
    assert.ok(html.includes("feature-dev-worktree"), "should reference feature-dev-worktree");
    assert.ok(html.includes("feature-dev-merge-worktree"), "should reference feature-dev-merge-worktree");
    assert.ok(html.includes("feature-dev-github-pr"), "should reference feature-dev-github-pr");
  });

  it("has Bug Fix table with correct data", () => {
    assert.ok(html.includes("bug-fix"), "should reference bug-fix workflow");
    assert.ok(html.includes("bug-fix-merge"), "should reference bug-fix-merge");
    assert.ok(html.includes("bug-fix-worktree"), "should reference bug-fix-worktree");
    assert.ok(html.includes("bug-fix-merge-worktree"), "should reference bug-fix-merge-worktree");
    assert.ok(html.includes("bug-fix-github-pr"), "should reference bug-fix-github-pr");
  });

  it("has Security Audit table with correct data", () => {
    assert.ok(html.includes("security-audit"), "should reference security-audit workflow");
    assert.ok(html.includes("security-audit-merge"), "should reference security-audit-merge");
    assert.ok(html.includes("security-audit-worktree"), "should reference security-audit-worktree");
    assert.ok(html.includes("security-audit-merge-worktree"), "should reference security-audit-merge-worktree");
    assert.ok(html.includes("security-audit-github-pr"), "should reference security-audit-github-pr");
  });

  it("has Quarantine Broken Tests table with correct data", () => {
    assert.ok(html.includes("quarantine-broken-tests"), "should reference quarantine-broken-tests workflow");
    assert.ok(html.includes("quarantine-broken-tests-merge"), "should reference quarantine-broken-tests-merge");
    assert.ok(html.includes("quarantine-broken-tests-merge-worktree"), "should reference quarantine-broken-tests-merge-worktree");
  });

  it("Quarantine Broken Tests table has 3 data rows", () => {
    // Find the Quarantine Broken Tests tbody and count <tr> rows
    const qbtMatch = html.match(/Quarantine Broken Tests variants[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/);
    assert.ok(qbtMatch, "should have Quarantine Broken Tests tbody");
    const rowCount = (qbtMatch[1].match(/<tr\b/g) || []).length;
    assert.strictEqual(rowCount, 3, `Quarantine Broken Tests table should have 3 data rows, got ${rowCount}`);
  });

  it("has Quick Tasks table with correct data", () => {
    assert.ok(html.includes("do-now"), "should reference do-now workflow");
    assert.ok(html.includes("just-do-it"), "should reference just-do-it workflow");
    assert.ok(html.includes("do-review-do-verify"), "should reference do-review-do-verify");
  });

  it("documents rugpull replacement-run behavior", () => {
    assert.ok(
      html.includes("rugpull") || html.includes("Rugpull"),
      "www/index.html should document rugpull handling"
    );
    assert.ok(
      html.includes("--no-relaunch-upon-rugpull"),
      "www/index.html should document --no-relaunch-upon-rugpull option"
    );
    assert.ok(
      html.includes("replacement run") || html.includes("replacement-run"),
      "www/index.html should mention replacement run behavior"
    );
  });

  it("just-do-it row describes merge-worktree default for coding tasks", () => {
    // Find the table row containing just-do-it
    const justDoItMatch = html.match(/<code>just-do-it<\/code>[\s\S]*?<\/tr>/);
    assert.ok(justDoItMatch, "should have just-do-it table row");
    const rowText = justDoItMatch[0];
    assert.ok(
      rowText.includes("merge-worktree") || rowText.includes("merge-worktree variants"),
      "just-do-it description should mention merge-worktree default"
    );
    assert.ok(
      /feature-dev.*bug-fix.*security-audit/.test(rowText) ||
      rowText.includes("coding tasks"),
      "just-do-it description should reference coding task workflows"
    );
  });

  // Footer
  it("footer contains MIT license", () => {
    assert.ok(html.includes("MIT"), "footer should mention MIT license");
  });

  it("footer contains origins credit", () => {
    assert.ok(
      html.includes("antfarm"),
      "footer should mention antfarm"
    );
  });

  it("links to docs/creating-workflows.md", () => {
    assert.ok(
      html.includes("docs/creating-workflows.md"),
      "should link to creating-workflows.md"
    );
  });

  // ── US-002: Full guide link ─────────────────────────────────────────

  it("Full guide link points to raw GitHub creating-workflows.md", () => {
    assert.ok(
      html.includes("https://raw.githubusercontent.com/igorhvr/tamandua/refs/heads/main/docs/creating-workflows.md"),
      "Full guide link should point to raw GitHub URL"
    );
  });

  it("Full guide link text reads 'Full guide.'", () => {
    const fullGuideLink = html.match(/<a[^>]+href="https:\/\/raw\.githubusercontent\.com\/igorhvr\/tamandua\/refs\/heads\/main\/docs\/creating-workflows\.md"[^>]*>([^<]+)<\/a>/);
    assert.ok(fullGuideLink, "should have Full guide link");
    assert.strictEqual(fullGuideLink[1], "Full guide.", "link text should be 'Full guide.'");
  });

  it("links to GitHub repository", () => {
    assert.ok(
      html.includes("github.com/igorhvr/tamandua"),
      "should link to the GitHub repo"
    );
  });

  // ── US-002: Dashboard & Kanban nav link and section reorder ──────

  it("nav contains 'Dashboard & Kanban' link between 'How It Works' and 'Build Your Own'", () => {
    const navLinksMatch = html.match(/<ul[^>]*id="nav-links"[^>]*>([\s\S]*?)<\/ul>/);
    assert.ok(navLinksMatch, "should have nav-links ul");
    const navLinks = navLinksMatch[1];
    const howPos = navLinks.indexOf('How It Works');
    const dashPos = navLinks.indexOf('Dashboard &amp; Kanban');
    const buildPos = navLinks.indexOf('Build Your Own');
    assert.ok(howPos >= 0, "nav should contain 'How It Works'");
    assert.ok(dashPos >= 0, "nav should contain 'Dashboard &amp; Kanban'");
    assert.ok(buildPos >= 0, "nav should contain 'Build Your Own'");
    assert.ok(howPos < dashPos, "'How It Works' should come before 'Dashboard &amp; Kanban' in nav");
    assert.ok(dashPos < buildPos, "'Dashboard &amp; Kanban' should come before 'Build Your Own' in nav");
  });

  it("Dashboard nav link href is '#dashboard'", () => {
    assert.ok(
      /<a[^>]+href="#dashboard"[^>]*>Dashboard &amp; Kanban<\/a>/.test(html),
      "nav should have <a href='#dashboard'>Dashboard &amp; Kanban</a>"
    );
  });

  it("dashboard section appears before build-your-own section in HTML source", () => {
    const dashboardPos = html.search(/<section[^>]*id="dashboard"/);
    const buildPos = html.search(/<section[^>]*id="build-your-own"/);
    assert.ok(dashboardPos >= 0, "should have <section id='dashboard'>");
    assert.ok(buildPos >= 0, "should have <section id='build-your-own'>");
    assert.ok(dashboardPos < buildPos, "dashboard section should appear before build-your-own section");
  });

  it("nav link order matches expected sequence", () => {
    const navLinksMatch = html.match(/<ul[^>]*id="nav-links"[^>]*>([\s\S]*?)<\/ul>/);
    assert.ok(navLinksMatch, "should have nav-links ul");
    const navLinks = navLinksMatch[1];
    const expected = ['Features', 'Workflows', 'Install', 'Why It Works', 'How It Works', 'Dashboard', 'Build Your Own', 'Usable by Agents'];
    let lastPos = -1;
    for (const text of expected) {
      const pos = navLinks.indexOf(text);
      assert.ok(pos >= 0, `nav should contain '${text}'`);
      assert.ok(pos > lastPos, `'${text}' should appear after previous link in nav order`);
      lastPos = pos;
    }
  });

  // ── US-001: Rename MCP Tools nav link to Usable by Agents ─────────

  it("nav contains 'Usable by Agents' link, not 'MCP Tools'", () => {
    assert.ok(
      html.includes('Usable by Agents'),
      "nav should contain 'Usable by Agents' text"
    );
    // After the rename, 'MCP Tools' should NOT appear as nav text
    // (it may still appear in explanatory text elsewhere)
    const navMatch = html.match(/<nav[^>]*>[\s\S]*?<\/nav>/);
    if (navMatch) {
      assert.ok(
        navMatch[0].includes('Usable by Agents'),
        "nav block should contain 'Usable by Agents'"
      );
      assert.ok(
        !/>MCP Tools</.test(navMatch[0]),
        "nav block should NOT contain '>MCP Tools<' as link text"
      );
    }
  });

  it("MCP nav link href is now '#skills-and-mcp'", () => {
    assert.ok(
      /<a[^>]+href="#skills-and-mcp"[^>]*>/.test(html),
      "nav should have an <a href='#skills-and-mcp' ...> element"
    );
  });

  it("MCP section contains 'Skill included.' text before 'Remote MCP Tools' heading", () => {
    const mcpSection = html.match(/<section[^>]*id="skills-and-mcp"[^>]*>[\s\S]*?<\/section>/)?.[0] || "";
    assert.ok(
      mcpSection.includes('<strong>Skill included.</strong>'),
      "MCP section should contain '<strong>Skill included.</strong>'"
    );
    assert.ok(
      mcpSection.includes('tamandua-agents skill'),
      "MCP section should mention 'tamandua-agents skill'"
    );
    // Verify ordering: Skill included text comes before Remote MCP Tools heading
    const skillPos = mcpSection.indexOf('Skill included.');
    const headingPos = mcpSection.indexOf('Remote MCP Tools');
    assert.ok(
      skillPos < headingPos,
      "'Skill included.' should appear before 'Remote MCP Tools' heading"
    );
  });

  it("Skill included explainer describes agent-friendly design", () => {
    assert.ok(
      html.includes('build-and-forget with tamandua'),
      "explainer should mention build-and-forget with tamandua"
    );
    assert.ok(
      html.includes('CLI itself is also designed'),
      "explainer should mention CLI being agent-friendly"
    );
  });

  // MCP tools table
  it("describes Remote MCP tools", () => {
    assert.ok(html.includes("tamandua.runs.list"), "should mention tamandua.runs.list");
    assert.ok(html.includes("tamandua.run.status"), "should mention tamandua.run.status");
    assert.ok(html.includes("tamandua.run.start"), "should mention tamandua.run.start");
  });

  // Code blocks
  it("has code blocks for commands", () => {
    const codeBlocks = (html.match(/<pre><code>/g) || []).length;
    assert.ok(codeBlocks >= 4, `should have at least 4 code blocks, got ${codeBlocks}`);
  });

  // Table counts
  it("has at least 5 tables with thead/tbody", () => {
    const tableCount = (html.match(/<table\b/g) || []).length;
    assert.ok(tableCount >= 6, `should have at least 6 tables, got ${tableCount}`);
    const theadCount = (html.match(/<thead>/g) || []).length;
    assert.ok(theadCount >= 6, `should have at least 6 thead elements, got ${theadCount}`);
  });

  // Heading hierarchy
  it("has h1 heading", () => {
    const h1Count = (html.match(/<h1\b/g) || []).length;
    assert.ok(h1Count >= 1, `should have at least 1 h1, got ${h1Count}`);
  });

  it("has multiple h2 headings", () => {
    const h2Count = (html.match(/<h2\b/g) || []).length;
    assert.ok(h2Count >= 4, `should have at least 4 h2 headings, got ${h2Count}`);
  });

  // Prerequisites
  it("mentions prerequisites", () => {
    assert.ok(html.includes("Node.js"), "should mention Node.js");
    assert.ok(html.includes("pi"), "should mention pi");
  });

  // ── US-004: Hero and Navigation ─────────────────────────────────────

  it("has CTA button in hero section", () => {
    assert.ok(
      /<a[^>]*class="cta-button"[^>]*>/.test(html),
      "hero should contain an <a> with class='cta-button'"
    );
    assert.ok(
      html.includes("Get Started"),
      "CTA button should have text 'Get Started'"
    );
  });

  it("has mobile hamburger menu checkbox", () => {
    assert.ok(
      html.includes('id="nav-toggle"') || html.includes("nav-toggle"),
      "should have a nav toggle checkbox (CSS hamburger menu)"
    );
    assert.ok(
      html.includes("nav-hamburger"),
      "should have hamburger icon element"
    );
  });

  it("navigation links list has id for CSS targeting", () => {
    assert.ok(
      /<ul[^>]*id="nav-links"/.test(html),
      "nav <ul> should have id='nav-links' for CSS targeting"
    );
  });

  it("hero install command block is wrapped in container div", () => {
    assert.ok(
      /class="hero-install"/.test(html),
      "install command should be in .hero-install div"
    );
  });

  it("hero content is wrapped in hero-content div", () => {
    assert.ok(
      /class="hero-content"/.test(html),
      "hero should have .hero-content wrapper for layout"
    );
  });

  it("logo is a link for home navigation", () => {
    assert.ok(
      /<a[^>]*class="logo"/.test(html),
      "logo should be an <a> tag with class='logo'"
    );
  });

  // ── US-005: Feature Cards with Icons ─────────────────────────────────

  it("feature cards have emoji icons", () => {
    const featureIcons = (html.match(/class="feature-icon"/g) || []).length;
    assert.ok(featureIcons === 4,
      `should have 4 .feature-icon elements, got ${featureIcons}`);
    // Each icon should have aria-hidden="true"
    assert.ok(
      /<span[^>]*class="feature-icon"[^>]*aria-hidden="true"/.test(html),
      "feature icons should have aria-hidden='true'"
    );
  });

  // ── US-005: Architecture Flow ────────────────────────────────────────

  it("how-it-works has architecture-flow container", () => {
    assert.ok(
      /class="architecture-flow"/.test(html),
      "should have .architecture-flow container in How It Works section"
    );
  });

  it("architecture flow has three steps with numbers", () => {
    assert.ok(
      /class="arch-step"/.test(html),
      "should have .arch-step elements"
    );
    assert.ok(
      /class="arch-arrow"/.test(html),
      "should have .arch-arrow elements connecting steps"
    );
    assert.ok(
      /class="arch-number"/.test(html),
      "should have .arch-number badge elements"
    );
    // Verify three steps: Define, Install, Run
    const archSteps = (html.match(/class="arch-step"/g) || []).length;
    assert.ok(archSteps === 3,
      `should have exactly 3 arch-step elements, got ${archSteps}`);
    assert.ok(
      html.includes("Define") && html.includes("Install") && html.includes("Run"),
      "architecture flow should contain Define, Install, and Run steps"
    );
  });

  it("architecture arrows have aria-hidden", () => {
    assert.ok(
      /class="arch-arrow"[^>]*aria-hidden="true"/.test(html),
      "arch-arrow should have aria-hidden='true'"
    );
  });

  // ── US-006: Installation Grid ───────────────────────────────────────

  it("install section has two-column grid wrapper", () => {
    assert.ok(
      /class="install-grid"/.test(html),
      "install section should have .install-grid wrapper"
    );
  });

  it("install section has two column divs", () => {
    const columns = (html.match(/class="install-column"/g) || []).length;
    assert.ok(columns === 2,
      `should have exactly 2 .install-column divs, got ${columns}`);
  });

  it("install section has prerequisites in a dedicated div", () => {
    assert.ok(
      /class="install-prereqs"/.test(html),
      "prerequisites should be in .install-prereqs div"
    );
  });

  // ── US-006: Why It Works List ───────────────────────────────────────

  it("why-it-works uses .why-list class on ordered list", () => {
    assert.ok(
      /class="why-list"/.test(html),
      "why-it-works ol should have class='why-list'"
    );
  });

  it("why-list has exactly 4 list items", () => {
    const whyList = html.match(/<ol\s+class="why-list"[^>]*>[\s\S]*?<\/ol>/)?.[0] || "";
    const liCount = (whyList.match(/<li\b/g) || []).length;
    assert.ok(liCount === 4,
      `why-list should have exactly 4 li items, got ${liCount}`);
  });

  // ── US-006: Footer Enhancements ─────────────────────────────────────

  it("footer columns use .footer-col class", () => {
    const footerCols = (html.match(/class="footer-col"/g) || []).length;
    assert.ok(footerCols === 3,
      `footer should have exactly 3 .footer-col divs, got ${footerCols}`);
  });

  it("footer has branding section with logo", () => {
    assert.ok(
      /class="footer-branding"/.test(html),
      "footer should have .footer-branding container"
    );
    assert.ok(
      /class="footer-logo"/.test(html),
      "footer should have .footer-logo element"
    );
    assert.ok(
      /class="footer-logo"[^>]*aria-hidden="true"/.test(html),
      "footer logo should have aria-hidden='true'"
    );
  });

  // ── US-008: Dashboard Screenshots ────────────────────────────────────

  it("dashboard section has two screenshot figures", () => {
    const screenshots = (html.match(/class="screenshot"/g) || []).length;
    assert.ok(screenshots >= 2,
      `dashboard section should have at least 2 screenshot figures, got ${screenshots}`);
  });

  it("screenshot images have alt text", () => {
    const altCount = (html.match(/alt="[^"]+"/g) || []).length;
    assert.ok(altCount >= 2,
      `screenshots should have at least 2 alt attributes, got ${altCount}`);
  });

  it("dashboard screenshot has correct src", () => {
    assert.ok(
      /src="assets\/dashboard-screenshot\.png"/.test(html),
      "dashboard screenshot should reference assets/dashboard-screenshot.png"
    );
  });

  it("kanban screenshot has correct src", () => {
    assert.ok(
      /src="assets\/dashboard-kanban\.png"/.test(html),
      "kanban screenshot should reference assets/dashboard-kanban.png"
    );
  });

  it("screenshots have figure wrapping with figcaption", () => {
    assert.ok(
      /<figcaption>/.test(html),
      "screenshots should have figcaption elements"
    );
  });

  it("screenshot images have loading='lazy'", () => {
    assert.ok(
      /loading="lazy"/.test(html),
      "screenshot images should have loading='lazy'"
    );
  });

  it("screenshot images have width and height attributes", () => {
    assert.ok(
      /width="1440"/.test(html),
      "screenshot images should have width attribute"
    );
    assert.ok(
      /height="900"/.test(html),
      "screenshot images should have height attribute"
    );
  });

  // ── US-009: Table Wrappers ──────────────────────────────────────────

  it("all tables are wrapped in .table-wrapper divs", () => {
    const tableCount = (html.match(/<table\b/g) || []).length;
    const wrapperCount = (html.match(/class="table-wrapper"/g) || []).length;
    assert.ok(wrapperCount === tableCount,
      `all ${tableCount} tables should be wrapped in .table-wrapper, got ${wrapperCount} wrappers`);
  });

  it("table wrapper divs have aria-label for accessibility", () => {
    const wrappers = html.match(/class="table-wrapper"[^>]*>/g) || [];
    assert.ok(wrappers.length >= 7,
      `should have at least 7 table wrappers with class, got ${wrappers.length}`);
    const withAriaLabel = wrappers.filter(w => /aria-label="/.test(w)).length;
    assert.ok(withAriaLabel >= 7,
      `all table wrappers should have aria-label, got ${withAriaLabel}`);
  });

  it("table wrappers have tabindex for keyboard scrollability", () => {
    const wrappers = html.match(/class="table-wrapper"[^>]*>/g) || [];
    const withTabindex = wrappers.filter(w => /tabindex="0"/.test(w)).length;
    assert.ok(withTabindex >= 7,
      `all table wrappers should have tabindex="0", got ${withTabindex}`);
  });

  // ── US-010: Accessibility ────────────────────────────────────────────

  it("logo is an img tag pointing to tamandua.png with alt text", () => {
    assert.ok(
      /<img[^>]*src="assets\/tamandua\.png"[^>]*alt="Tamandua logo"[^>]*>/.test(html),
      "logo should be <img src='assets/tamandua.png' alt='Tamandua logo'>"
    );
    assert.ok(
      /<img[^>]*width="32"[^>]*height="32"[^>]*>/.test(html),
      "tamandua.png img should have width='32' height='32'"
    );
  });

  it("all images have alt text", () => {
    const imgTags = html.match(/<img[^>]*>/g) || [];
    const withAlt = imgTags.filter(t => /\salt="/.test(t)).length;
    assert.ok(withAlt === imgTags.length,
      `all ${imgTags.length} img elements should have alt text, got ${withAlt} with alt`);
  });

  it("heading hierarchy is logical — h1 first, then h2, then h3", () => {
    const h1Pos = html.search(/<h1\b/);
    const h2Pos = html.search(/<h2\b/);
    const h3Pos = html.search(/<h3\b/);
    assert.ok(h1Pos < h2Pos, "h1 should appear before first h2");
    assert.ok(h2Pos < h3Pos, "h2 should appear before first h3");
  });

  it("skip-to-content link is the first focusable element", () => {
    const skipPos = html.search(/class="skip-link"/);
    const headerPos = html.search(/<header\b/);
    assert.ok(skipPos < headerPos,
      "skip-to-content link should appear before <header> element");
  });
});
