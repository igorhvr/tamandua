import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const cssPath = resolve(__dirname, "..", "dist", "www", "styles.css");

let css: string;
try {
  css = readFileSync(cssPath, "utf-8");
} catch {
  css = "";
}

describe("www/styles.css", () => {
  it("exists and is not empty", () => {
    assert.ok(css.length > 0, "dist/www/styles.css must exist (run npm run build first)");
  });

  // ── CSS Custom Properties — Colors ──────────────────────────────────

  it("defines --color-bg custom property", () => {
    assert.ok(/--color-bg\s*:\s*#0d1117/m.test(css),
      "should define --color-bg: #0d1117");
  });

  it("defines --color-surface custom property", () => {
    assert.ok(/--color-surface\s*:\s*#161b22/m.test(css),
      "should define --color-surface: #161b22");
  });

  it("defines --color-border custom property", () => {
    assert.ok(/--color-border\s*:\s*#30363d/m.test(css),
      "should define --color-border: #30363d");
  });

  it("defines --color-text custom property", () => {
    assert.ok(/--color-text\s*:\s*#c9d1d9/m.test(css),
      "should define --color-text: #c9d1d9");
  });

  it("defines --color-accent custom property (#f0883e)", () => {
    assert.ok(/--color-accent\s*:\s*#f0883e/m.test(css),
      "should define --color-accent: #f0883e");
  });

  it("defines --color-success custom property", () => {
    assert.ok(/--color-success\s*:\s*#3fb950/m.test(css),
      "should define --color-success: #3fb950");
  });

  it("defines --color-info custom property", () => {
    assert.ok(/--color-info\s*:\s*#58a6ff/m.test(css),
      "should define --color-info: #58a6ff");
  });

  it("defines --color-text-muted (or --color-muted) custom property", () => {
    assert.ok(
      /--color-text-muted/.test(css) || /--color-muted/.test(css),
      "should define --color-text-muted or --color-muted"
    );
  });

  it("defines CSS custom properties for spacing", () => {
    assert.ok(/--space-[1246]/.test(css), "should define space custom properties");
  });

  it("defines CSS custom properties for border radii", () => {
    assert.ok(/--radius-/.test(css), "should define border-radius custom properties");
  });

  it("uses system font stack for body", () => {
    assert.ok(/font-family\s*:\s*.*-apple-system/.test(css) || /--font-body/.test(css),
      "should use system font stack");
  });

  it("uses monospace font stack for code", () => {
    assert.ok(/font-family\s*:\s*.*monospace/.test(css) || /--font-mono/.test(css),
      "should use monospace font stack");
  });

  it("defines font custom properties", () => {
    assert.ok(/--font-body/.test(css) || /--font-mono/.test(css),
      "should define font custom properties");
  });

  it("centers content with max-width 1200px", () => {
    assert.ok(/max-width\s*:\s*1200px/.test(css) || /--max-width\s*:\s*1200px/.test(css),
      "should use max-width: 1200px");
  });

  it("uses margin auto for centering", () => {
    assert.ok(/margin\s*:\s*0\s+auto/.test(css) || /margin-left\s*:\s*auto/.test(css),
      "should use auto margins for centering");
  });

  it("sets dark background on body", () => {
    assert.ok(/body\s*\{[^}]*background[^}]*var\(--color-bg\)/.test(css) ||
      /body\s*\{[^}]*background-color[^}]*var\(--color-bg\)/.test(css),
      "body should use dark background");
  });

  it("includes box-sizing border-box reset", () => {
    assert.ok(/box-sizing\s*:\s*border-box/.test(css), "should have border-box reset");
  });

  it("defines a mobile-first breakpoint at 768px", () => {
    assert.ok(
      /@media\s*\(min-width\s*:\s*768px\)/.test(css) || /@media\s*\(max-width\s*:\s*767px\)/.test(css),
      "should define a breakpoint at 768px"
    );
  });

  it("includes print stylesheet via media print query", () => {
    assert.ok(/@media\s+print/.test(css), "should include @media print");
  });

  it("print styles hide non-essential elements", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /display\s*:\s*none/.test(printBlock),
      "print styles should use display:none to hide elements"
    );
  });

  it("does not import external CSS frameworks", () => {
    assert.ok(!/@import\s+url/.test(css), "should not import external CSS files");
  });

  it("styles sections with padding", () => {
    assert.ok(/section\s*\{[^}]*padding/.test(css) || /section[\s\S]*?padding/.test(css),
      "sections should have padding");
  });

  it("uses border-top for section separation", () => {
    assert.ok(/border-top/.test(css), "should use border-top for separation");
  });

  it("styles the skip-to-content link", () => {
    assert.ok(/\.skip-link/.test(css), "should style .skip-link");
  });

  it("hero has dark gradient background", () => {
    assert.ok(
      /#hero[^}]*background[^}]*gradient/.test(css) || /#hero[^}]*background[^}]*radial-gradient/s.test(css),
      "hero should have gradient background"
    );
  });

  it("hero has CSS-only dot pattern overlay", () => {
    assert.ok(
      /#hero::before/.test(css),
      "hero should have ::before pseudo-element for dot pattern"
    );
  });

  it("hero has large decorative emoji accent", () => {
    assert.ok(
      /#hero::after/.test(css),
      "hero should have ::after pseudo-element for decorative emoji"
    );
  });

  it("sticky header has glass-morphism backdrop-filter", () => {
    assert.ok(
      /backdrop-filter\s*:\s*blur/.test(css) || /-webkit-backdrop-filter\s*:\s*blur/.test(css),
      "header should use backdrop-filter blur for glass-morphism"
    );
  });

  it("CTA button uses accent orange (#f0883e)", () => {
    assert.ok(
      /\.cta-button[^}]*background[^}]*var\(--color-accent\)/.test(css) ||
      /\.cta-button[^}]*background-color[^}]*var\(--color-accent\)/.test(css) ||
      /\.cta-button[^}]*background[^}]*var\(--gradient-accent\)/.test(css) ||
      /\.cta-button[^}]*background\s*:\s*#f0883e/.test(css),
      "CTA button should use accent orange"
    );
  });

  it("CTA button has hover transition", () => {
    assert.ok(
      /\.cta-button:hover/.test(css),
      "CTA button should have hover state"
    );
  });

  it("CTA button hover scales or lifts", () => {
    assert.ok(
      /\.cta-button:hover[^}]*transform/.test(css),
      "CTA button hover should have transform"
    );
  });

  it("has hamburger menu styles for mobile", () => {
    assert.ok(
      /\.nav-toggle/.test(css) || /nav-toggle/.test(css),
      "should have hamburger menu styles"
    );
  });

  it("hamburger menu uses CSS-only toggle mechanism", () => {
    assert.ok(
      /\.nav-toggle:checked/.test(css),
      "should use :checked pseudo-class for CSS-only toggle"
    );
  });

  it("hamburger animates to X when open", () => {
    assert.ok(
      /\.nav-toggle:checked[^}]*\.nav-hamburger/.test(css) ||
      /:checked.*nav-hamburger[\s\S]*?transform\s*:\s*rotate/.test(css),
      "hamburger should animate to X using transform:rotate"
    );
  });

  it("mobile nav links are hidden by default", () => {
    assert.ok(
      /#nav-links[^}]*display\s*:\s*none/.test(css),
      "mobile nav links should be hidden by default"
    );
  });

  it("mobile hamburger toggle has 44x44px touch target", () => {
    assert.ok(
      /\.nav-toggle-label[^}]*width\s*:\s*44px/.test(css) || /\.nav-toggle-label[^}]*height\s*:\s*44px/.test(css),
      "hamburger toggle should have 44x44px touch area"
    );
  });

  it("headings use letter-spacing for readability", () => {
    assert.ok(/letter-spacing/.test(css), "headings should use letter-spacing");
  });

  it("hero heading has negative letter-spacing for large text", () => {
    assert.ok(
      /#hero\s+h1[^}]*letter-spacing\s*:\s*-0\.0\d+em/.test(css),
      "hero h1 should have negative letter-spacing"
    );
  });

  // ── Why cards with SVG icons ─────────────────────────────────────

  it("why cards use .why-card class with styling", () => {
    assert.ok(
      /\.why-card/.test(css),
      "should have .why-card styling"
    );
  });

  it("why cards have hover elevation transition", () => {
    assert.ok(
      /\.why-card:hover/.test(css),
      "why cards should have hover state"
    );
  });

  it("why cards use 2x2 responsive grid on desktop", () => {
    assert.ok(
      /repeat\(2,\s*1fr\)/.test(css),
      "should use 2-column grid on desktop"
    );
  });

  it("why card icons use .why-card-icon class", () => {
    assert.ok(
      /\.why-card-icon/.test(css),
      "should have .why-card-icon styling"
    );
  });

  // ── Pipeline Flow ────────────────────────────────────────────────

  it("pipeline flow uses flex layout", () => {
    assert.ok(
      /\.pipeline-flow[^}]*display\s*:\s*flex/.test(css),
      "pipeline flow should use flex"
    );
  });

  it("pipeline-steps have surface background with border", () => {
    assert.ok(
      /\.pipeline-step[^}]*background[^}]*var\(--color-surface\)/.test(css),
      "pipeline steps should use surface background"
    );
  });

  it("pipeline-number uses circular badge with accent color", () => {
    assert.ok(
      /\.pipeline-number[^}]*border-radius\s*:\s*50%/.test(css),
      "pipeline number badge should be circular"
    );
  });

  it("pipeline-connectors use accent color opacity", () => {
    assert.ok(
      /\.pipeline-connector[^}]*color\s*:\s*var\(--color-accent\)/.test(css),
      "pipeline connectors should use accent color"
    );
  });

  it("pipeline flow switches to horizontal on desktop", () => {
    assert.ok(
      /flex-direction\s*:\s*row/.test(css),
      "pipeline should go horizontal on desktop"
    );
  });

  it("tables have striped rows for readability", () => {
    assert.ok(
      /tbody\s+tr:nth-child\(even\)/.test(css),
      "tables should have striped even rows"
    );
  });

  it("tables have row hover highlight", () => {
    assert.ok(
      /tbody\s+tr:hover/.test(css),
      "tables should have row hover highlight"
    );
  });

  it("table headers use uppercase small text", () => {
    assert.ok(
      /th[^}]*text-transform\s*:\s*uppercase/.test(css),
      "table headers should be uppercase"
    );
  });

  it("code blocks use monospace font with dark background", () => {
    assert.ok(
      /pre[^}]*background\s*:[^};]*var\(--color-surface\)/.test(css),
      "code blocks should have dark surface background"
    );
  });

  it("install grid uses two-column layout on desktop", () => {
    assert.ok(
      /\.install-grid/.test(css) || /repeat\(2,\s*1fr\)/.test(css),
      "install section should use grid layout"
    );
  });

  it("install columns have surface background with border", () => {
    assert.ok(
      /\.install-column[^}]*background[^}]*var\(--color-surface\)/.test(css),
      "install columns should have surface background"
    );
  });

  it("install columns have hover effect", () => {
    assert.ok(
      /\.install-column:hover/.test(css),
      "install columns should have hover effect"
    );
  });

  it("install prerequisites have left-border accent", () => {
    assert.ok(
      /\.install-prereqs[^}]*border-left/.test(css),
      "prerequisites should have left border"
    );
  });

  it("footer has dark background with gradient", () => {
    assert.ok(
      /footer[^}]*background[^}]*gradient/.test(css) || /footer[^}]*radial-gradient/.test(css),
      "footer should have gradient background"
    );
  });

  it("footer grid has three columns on desktop", () => {
    assert.ok(
      /repeat\(3,\s*1fr\)/.test(css),
      "footer should use 3-column grid on desktop"
    );
  });

  it("footer has centered branding section", () => {
    assert.ok(
      /\.footer-branding/.test(css),
      "footer should have .footer-branding styling"
    );
  });

  it("footer logo has styling", () => {
    assert.ok(
      /\.footer-logo/.test(css),
      "footer logo should have styling"
    );
  });

  it("screenshot container has theme-matching border", () => {
    assert.ok(
      /\.screenshot[^}]*border[^}]*var\(--color-border\)/.test(css),
      "screenshot should have themed border"
    );
  });

  it("screenshot images are responsive", () => {
    assert.ok(
      /\.screenshot\s+img[^}]*width\s*:\s*100%/.test(css),
      "screenshot images should be responsive"
    );
  });

  it("screenshot figcaption has muted styling", () => {
    assert.ok(
      /\.screenshot\s+figcaption/.test(css),
      "screenshot figcaption should have styling"
    );
  });

  it("screenshot hover effect uses accent color", () => {
    assert.ok(
      /\.screenshot:hover[^}]*var\(--color-accent\)/.test(css),
      "screenshot hover should use accent color"
    );
  });

  it("print styles include screenshot handling", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /\.screenshot/.test(printBlock),
      "print styles should handle screenshots"
    );
  });

  it("table-wrapper enables horizontal overflow scroll", () => {
    assert.ok(
      /\.table-wrapper[^}]*overflow-x\s*:\s*auto/.test(css),
      "table wrapper should enable horizontal scroll"
    );
  });

  it("table-wrapper uses momentum scrolling on iOS", () => {
    assert.ok(
      /-webkit-overflow-scrolling\s*:\s*touch/.test(css),
      "table wrapper should support iOS momentum scrolling"
    );
  });

  it("table-wrapper has scroll hint shadow via background gradients", () => {
    assert.ok(
      /\.table-wrapper[^}]*background-attachment\s*:\s*local[^}]*scroll/.test(css) ||
      /\.table-wrapper[\s\S]*?background-attachment\s*:\s*local/.test(css),
      "table wrapper should have scroll hint shadows"
    );
  });

  it("images have max-width: 100% to prevent overflow", () => {
    assert.ok(
      /img[^}]*max-width\s*:\s*100%/.test(css),
      "images should have max-width: 100%"
    );
  });

  it("images have height: auto for aspect ratio preservation", () => {
    assert.ok(
      /img[^}]*height\s*:\s*auto/.test(css),
      "images should have height: auto"
    );
  });

  it("copy buttons have minimum 44x44px touch area", () => {
    assert.ok(
      /\.copy-btn[^}]*min-(width|height)\s*:\s*44px/.test(css),
      "copy buttons should have 44x44px minimum touch area"
    );
  });

  it("nav links have minimum 44px height for touch", () => {
    assert.ok(
      /#nav-links\s+a[^}]*min-height\s*:\s*44px/.test(css),
      "nav links should have minimum 44px height"
    );
  });

  it("CTA button has minimum 44px touch target", () => {
    assert.ok(
      /\.cta-button[^}]*min-height\s*:\s*44px/.test(css),
      "CTA button should have minimum 44px height"
    );
  });

  it("body text is at least 16px (1rem) default", () => {
    const bodyBlock = css.match(/body\s*\{[^}]*\}/s)?.[0] || "";
    assert.ok(
      /font-size\s*:\s*var\(--fs-base\)/.test(bodyBlock) || /font-size\s*:\s*1rem/.test(bodyBlock),
      "body should have base font-size at least 1rem (16px)"
    );
  });

  it("mobile section padding is reduced for information density", () => {
    const mobileSectionMatch = css.match(/@media\s*\(max-width\s*:\s*767px\)[\s\S]*?--section-pad[\s\S]*?\n\}/);
    assert.ok(
      mobileSectionMatch !== null || /--section-pad\s*:\s*var\(--space-[123456]\)/.test(css),
      "mobile media query should override --section-pad to a smaller value"
    );
  });

  it("mobile breakpoint scales down headings", () => {
    const mobileH1Match = css.match(/@media\s*\(max-width\s*:\s*767px\)[\s\S]*?h1\s*\{[\s\S]*?font-size/);
    assert.ok(
      mobileH1Match !== null || /\bh1\b[^}]*font-size\s*:\s*var\(--fs-[23]xl\)/.test(css),
      "mobile breakpoint should adjust h1 font-size"
    );
  });

  it("mobile prevents horizontal overflow on body", () => {
    const mobileBodyMatch = css.match(/@media\s*\(max-width\s*:\s*767px\)[\s\S]*?body\s*\{[\s\S]*?overflow-x\s*:\s*hidden/);
    assert.ok(
      mobileBodyMatch !== null,
      "mobile should set overflow-x: hidden on body to prevent horizontal scroll"
    );
  });

  it("why cards are 1 column by default (mobile-first)", () => {
    const whyGridBlock = css.match(/\.why-grid\s*\{[^}]*\}/s)?.[0] || "";
    assert.ok(
      /grid-template-columns\s*:\s*1fr/.test(whyGridBlock),
      "why-grid should default to 1 column (1fr) mobile-first"
    );
  });

  it("why cards switch to 2 columns at 768px breakpoint", () => {
    const tabletMatch = css.match(/@media\s*\(min-width\s*:\s*768px\)[\s\S]*?\.why-grid\s*\{[\s\S]*?repeat\(2,\s*1fr\)[\s\S]*?\n\s*\}/);
    assert.ok(
      tabletMatch !== null ||
        css.includes("repeat(2, 1fr)"),
      "why-grid should be 2 columns at 768px"
    );
  });

  it("has breakpoint for 768px (tablet)", () => {
    assert.ok(
      /@media\s*\(min-width\s*:\s*768px\)/.test(css),
      "should have a 768px tablet breakpoint"
    );
  });

  it("has breakpoint for 1024px (desktop)", () => {
    assert.ok(
      /@media\s*\(min-width\s*:\s*1024px\)/.test(css),
      "should have a 1024px desktop breakpoint"
    );
  });

  it("has breakpoint for 1440px (large desktop)", () => {
    assert.ok(
      /@media\s*\(min-width\s*:\s*1440px\)/.test(css),
      "should have a 1440px large desktop breakpoint"
    );
  });

  // ── Focus Indicators ─────────────────────────────────────────────

  it("has global :focus-visible outline style", () => {
    assert.ok(
      /:focus-visible[^}]*outline\s*:\s*2px\s+solid\s+var\(--color-accent\)/.test(css) ||
      /:focus-visible[\s\S]*?outline\s*:\s*2px\s+solid\s+#f0883e/.test(css),
      "should have global :focus-visible with accent outline"
    );
  });

  it("nav links have focus-visible indicator", () => {
    assert.ok(
      /nav\s+ul\s+li\s+a:focus-visible/.test(css) || /#nav-links\s+a:focus-visible/.test(css),
      "nav links should have focus-visible style"
    );
  });

  it("table wrapper has focus-visible indicator", () => {
    assert.ok(
      /\.table-wrapper:focus-visible/.test(css),
      "table wrapper should have focus-visible style"
    );
  });

  it("general links have focus-visible style", () => {
    assert.ok(
      /^a:focus-visible/m.test(css) || /\ba:focus-visible\b/.test(css),
      "general <a> elements should have focus-visible style"
    );
  });

  // ── aria-current Support ─────────────────────────────────────────

  it("active nav link also matches [aria-current='page']", () => {
    assert.ok(
      /#nav-links\s+a\[aria-current="page"\]/.test(css),
      "should style nav links with aria-current=\"page\""
    );
  });

  // ── Improved Print Styles ────────────────────────────────────────

  it("print styles hide CTA button", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /\.cta-button/.test(printBlock),
      "print styles should hide CTA button"
    );
  });

  it("print styles hide copy buttons", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /\.copy-btn/.test(printBlock),
      "print styles should hide copy buttons"
    );
  });

  it("print styles hide pseudo-element decorations", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /#hero::before/.test(printBlock) || /#hero::after/.test(printBlock),
      "print styles should hide hero pseudo-element decorations"
    );
  });

  it("print styles remove animations and transitions", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /animation\s*:\s*none/.test(printBlock),
      "print styles should disable animations"
    );
    assert.ok(
      /transition\s*:\s*none/.test(printBlock),
      "print styles should disable transitions"
    );
  });

  it("print styles remove backdrop-filter", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /backdrop-filter\s*:\s*none/.test(printBlock),
      "print styles should remove backdrop-filter"
    );
  });

  it("print styles use black on white text", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /color\s*:\s*#000/.test(printBlock),
      "print styles should use black text"
    );
    assert.ok(
      /background\s*:\s*#fff/.test(printBlock),
      "print styles should use white background"
    );
  });

  it("print styles show full URLs on links", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /a\[href\]::after[^}]*content[^}]*attr\(href\)/.test(printBlock),
      "print styles should show full URLs via attr(href)"
    );
  });

  it("print styles don't show URLs for anchor links", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /a\[href\^="#"]::after[^}]*content\s*:\s*none/.test(printBlock),
      "print styles should hide URLs for same-page anchor links"
    );
  });

  it("print styles show all section-reveal content", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /\.section-reveal/.test(printBlock),
      "print styles should make section-reveal content visible"
    );
  });

  it("print styles clean table wrapper backgrounds", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /\.table-wrapper/.test(printBlock),
      "print styles should handle table-wrapper backgrounds"
    );
  });

  it("print styles handle code block overflow", () => {
    const printBlock = css.match(/@media\s+print\s*\{[\s\S]*?\n\}/)?.[0] || "";
    assert.ok(
      /pre[^}]*white-space\s*:\s*pre-wrap/.test(printBlock) || /word-wrap/.test(printBlock),
      "print styles should handle long code lines"
    );
  });
});
