// Tests for progressive JavaScript enhancements — US-007
// Tests verify the script structure, CSS classes, and HTML elements
// that support the JS enhancements. Full behavioral testing would
// require a browser (JSDOM or Playwright), so these tests verify
// the structural contracts the JS relies on.

import { describe, it } from 'node:test';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as assert from 'node:assert/strict';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distDir = resolve(__dirname, '..', 'dist', 'www');

function readDistFile(filename: string) {
  return readFileSync(resolve(distDir, filename), 'utf-8');
}

function extractFunction(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`  function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `should find ${name} in scripts.js`);
  return source.slice(start, end);
}

let scriptsJs = '';
let html = '';
let css = '';

try { scriptsJs = readDistFile('scripts.js'); } catch {}
try { html = readDistFile('index.html'); } catch {}
try { css = readDistFile('styles.css'); } catch {}

describe('US-007: Progressive JavaScript enhancements', () => {
  // ── 1. Script file existence and structure ────────────────────────
  describe('scripts.js', () => {
    it('has scripts.js in dist/www', () => {
      assert.ok(scriptsJs.length > 0, 'scripts.js should not be empty after build');
    });

    it('wraps code in DOMContentLoaded', () => {
      assert.ok(
        scriptsJs.includes("DOMContentLoaded"),
        'scripts.js should wait for DOMContentLoaded'
      );
    });

    it("uses 'use strict'", () => {
      assert.ok(
        scriptsJs.includes("'use strict'"),
        "scripts.js should use strict mode"
      );
    });

    // ── Enhancement 1: Copy to clipboard ────────────────────────
    it('contains clipboard API usage for copy buttons', () => {
      assert.ok(
        scriptsJs.includes('navigator.clipboard') || scriptsJs.includes('clipboard.writeText'),
        'scripts.js should use navigator.clipboard for copy functionality'
      );
    });

    it('has copy button creation code', () => {
      assert.ok(
        scriptsJs.includes('copy-btn'),
        'scripts.js should create copy buttons with copy-btn class'
      );
    });

    it('has 2-second feedback timeout for copy', () => {
      assert.ok(
        scriptsJs.includes('2000'),
        'scripts.js should have 2-second timeout for "Copied!" feedback'
      );
    });

    it('handles clipboard failure gracefully', () => {
      assert.ok(
        scriptsJs.includes('.catch'),
        'scripts.js should have a catch handler for clipboard failures'
      );
    });

    // ── Enhancement 2: Smooth scroll ────────────────────────────
    it('uses scrollIntoView or scrollTo for navigation', () => {
      assert.ok(
        scriptsJs.includes('scrollIntoView') || scriptsJs.includes('scrollTo'),
        'scripts.js should use smooth scrolling APIs'
      );
    });

    it('intercepts anchor clicks with href starting with #', () => {
      assert.ok(
        scriptsJs.includes('a[href^="#"]'),
        'scripts.js should intercept internal anchor link clicks'
      );
    });

    // ── Enhancement 3: Intersection Observer ─────────────────────
    it('uses IntersectionObserver for reveal animations', () => {
      assert.ok(
        scriptsJs.includes('IntersectionObserver'),
        'scripts.js should use IntersectionObserver for section reveal'
      );
    });

    it('checks for IntersectionObserver support before using', () => {
      assert.ok(
        scriptsJs.includes("'IntersectionObserver' in window") ||
        scriptsJs.includes('"IntersectionObserver" in window'),
        'scripts.js should check for IntersectionObserver support'
      );
    });

    it('adds visible class when sections intersect', () => {
      assert.ok(
        scriptsJs.includes("classList.add('visible')"),
        'scripts.js should add visible class when section intersects viewport'
      );
    });

    it('observes elements with section-reveal class', () => {
      assert.ok(
        scriptsJs.includes('section-reveal'),
        'scripts.js should query for .section-reveal elements'
      );
    });

    // ── Enhancement 4: Dynamic copyright year ───────────────────
    it('dynamically sets copyright year', () => {
      assert.ok(
        scriptsJs.includes('getFullYear'),
        'scripts.js should use Date.getFullYear for dynamic copyright'
      );
    });

    it('targets copyright-year span element', () => {
      assert.ok(
        scriptsJs.includes('copyright-year'),
        'scripts.js should reference copyright-year element'
      );
    });

    // ── Enhancement 5: Mobile nav toggle ────────────────────────
    it('enhances mobile nav with JS', () => {
      assert.ok(
        scriptsJs.includes('nav-toggle'),
        'scripts.js should reference nav-toggle checkbox'
      );
    });

    it('closes mobile nav on Escape key', () => {
      assert.ok(
        scriptsJs.includes('Escape'),
        'scripts.js should close nav on Escape key press'
      );
    });

    it('closes mobile nav on outside click', () => {
      assert.ok(
        scriptsJs.includes('.contains'),
        'scripts.js should check click target containment for outside-click close'
      );
    });

    it('adds body.nav-open class when menu is open', () => {
      assert.ok(
        scriptsJs.includes("classList.add('nav-open')"),
        'scripts.js should add nav-open class to body when menu opens'
      );
    });

    it('removes body.nav-open class when menu is closed', () => {
      assert.ok(
        scriptsJs.includes("classList.remove('nav-open')"),
        'scripts.js should remove nav-open class from body when menu closes'
      );
    });

    it('manages focus within open mobile nav', () => {
      assert.ok(
        scriptsJs.includes('.focus()'),
        'scripts.js should handle focus for the mobile nav'
      );
    });

    // ── Enhancement 6: Active nav link highlighting ─────────────
    it('adds active class to nav links on scroll', () => {
      assert.ok(
        scriptsJs.includes("classList.add('active')"),
        'scripts.js should add active class to nav links'
      );
    });

    it('removes active class from non-current links', () => {
      assert.ok(
        scriptsJs.includes("classList.remove('active')"),
        'scripts.js should remove active class from non-active links'
      );
    });

    it('uses requestAnimationFrame for scroll performance', () => {
      assert.ok(
        scriptsJs.includes('requestAnimationFrame'),
        'scripts.js should throttle scroll with requestAnimationFrame'
      );
    });

    it('listens for scroll events', () => {
      assert.ok(
        scriptsJs.includes("addEventListener('scroll'"),
        'scripts.js should listen for scroll events'
      );
    });

    // ── Feature detection and quality ───────────────────────────
    it('uses passive scroll listener', () => {
      assert.ok(
        scriptsJs.includes('passive'),
        'scripts.js should use passive: true for scroll listeners'
      );
    });

    it('no external framework dependencies — vanilla only', () => {
      const hasRequire = /\brequire\b/.exec(scriptsJs);
      assert.equal(hasRequire, null, 'scripts.js should not use require (vanilla JS only)');
    });

    it('contains SVG icon for copy button', () => {
      assert.ok(
        scriptsJs.includes('<svg'),
        'scripts.js should include an SVG icon for the copy button'
      );
    });

    it('checks for scrollBehavior support', () => {
      assert.ok(
        scriptsJs.includes('scrollBehavior'),
        'scripts.js should check for scrollBehavior CSS property support'
      );
    });

    it('highlights the Build Your Own YAML without mangling span attributes', () => {
      const escapeSource = extractFunction(scriptsJs, 'escapeHtml', 'highlightShellLine');
      const yamlSource = extractFunction(scriptsJs, 'highlightYamlLine', 'highlightedLines');
      const highlightYamlLine = new Function(
        `${escapeSource}\n${yamlSource}\nreturn highlightYamlLine;`
      )() as (line: string) => string;
      const yamlMatch = html.match(/<code class="language-yaml">([\s\S]*?)<\/code>/);
      assert.ok(yamlMatch, 'Build Your Own YAML sample should exist');
      const yaml = yamlMatch[1];
      const highlighted = yaml.split('\n').map(highlightYamlLine).join('\n');

      assert.doesNotMatch(highlighted, /<span[^>]*<span/);
      for (const key of ['id', 'name', 'agents', 'workspace', 'files', 'AGENTS.md', 'steps', 'agent', 'input', 'expects']) {
        assert.ok(
          highlighted.includes(`<span class="tok-key">${key}</span>:`),
          `should highlight YAML key ${key}`
        );
      }
      assert.ok(
        highlighted.includes('<span class="tok-str">&quot;STATUS: done&quot;</span>'),
        'should highlight the quoted expects value'
      );

      const roundTripped = highlighted
        .replace(/<[^>]+>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
      assert.equal(roundTripped, yaml);
    });
  });

  // ── 2. HTML structural contracts ───────────────────────────────────
  describe('index.html contracts for JS enhancements', () => {
    it('has html content loaded', () => {
      assert.ok(html.length > 0, 'index.html should not be empty');
    });

    it('has section-reveal classes on content sections', () => {
      const matches = html.match(/class="section-reveal"/g);
      assert.ok(matches && matches.length >= 4,
        'At least 4 sections should have section-reveal class');
    });

    it('has copyright-year span in footer', () => {
      assert.ok(
        html.includes('id="copyright-year"'),
        'HTML should have #copyright-year span in footer'
      );
    });

    it('has copyright year fallback value of 2026', () => {
      assert.ok(
        html.includes('id="copyright-year">2026<'),
        'Copyright year should have static fallback of 2026'
      );
    });

    it('has nav-toggle checkbox for menu', () => {
      assert.ok(
        html.includes('id="nav-toggle"'),
        'HTML should have nav-toggle checkbox for mobile menu'
      );
    });

    it('has nav-links with anchor links', () => {
      assert.ok(
        html.includes('id="nav-links"'),
        'HTML should have nav-links element'
      );
    });

    it('has skip-to-content link', () => {
      assert.ok(
        html.includes('skip-link') || html.includes('Skip to content'),
        'HTML should have skip-to-content link'
      );
    });

    it('all sections have aria-labelledby for accessibility', () => {
      const sections = html.match(/<section[^>]*aria-labelledby="[^"]*"[^>]*>/g);
      assert.ok(sections && sections.length >= 4,
        'All sections should have aria-labelledby attributes');
    });

    it('scripts.js is loaded at end of body', () => {
      const scriptPos = html.indexOf('<script src="scripts.js">');
      const bodyClosePos = html.indexOf('</body>');
      assert.ok(scriptPos > -1, 'scripts.js script tag should exist');
      assert.ok(scriptPos < bodyClosePos,
        'scripts.js should be loaded before </body>');
    });

    it('page has lang="en"', () => {
      assert.ok(
        html.includes('lang="en"'),
        'HTML element should have lang="en"'
      );
    });

    it('nav links use href anchors for CSS-only fallback', () => {
      const navLinks = html.match(/href="#[^"]*"/g);
      assert.ok(navLinks && navLinks.length >= 4,
        'Navigation should have at least 4 anchor links for CSS-only navigation');
    });

    it('has mobile nav toggle label for CSS checkbox hack', () => {
      assert.ok(
        html.includes('nav-toggle-label'),
        'HTML should have CSS toggle label for mobile menu checkbox hack'
      );
    });

    it('has footer-copyright paragraph', () => {
      assert.ok(
        html.includes('footer-copyright'),
        'HTML should have footer-copyright class on copyright paragraph'
      );
    });
  });

  // ── 3. CSS contracts for JS-driven classes ─────────────────────────
  describe('styles.css contracts for JS-enhanced classes', () => {
    it('has css content loaded', () => {
      assert.ok(css.length > 0, 'styles.css should not be empty');
    });

    it('has .section-reveal with opacity and transform', () => {
      assert.ok(
        css.includes('.section-reveal'),
        'CSS should have .section-reveal class'
      );
      assert.ok(
        css.includes('opacity: 0') || css.includes('opacity:0'),
        'CSS .section-reveal should start with opacity 0'
      );
    });

    it('has .section-reveal.visible with opacity 1', () => {
      assert.ok(
        css.includes('.section-reveal.visible'),
        'CSS should have .section-reveal.visible class'
      );
    });

    it('has .copy-btn styling', () => {
      assert.ok(
        css.includes('.copy-btn'),
        'CSS should have .copy-btn class'
      );
    });

    it('has .copy-btn visible on pre:hover', () => {
      assert.ok(
        css.includes('pre:hover .copy-btn'),
        'CSS should show copy-btn on pre hover'
      );
    });

    it('has .copy-btn.copied state', () => {
      assert.ok(
        css.includes('.copy-btn.copied'),
        'CSS should have .copy-btn.copied state'
      );
    });

    it('has active nav link style', () => {
      assert.ok(
        css.includes('#nav-links a.active'),
        'CSS should style #nav-links a.active links'
      );
    });

    it('has body.nav-open scroll lock', () => {
      assert.ok(
        css.includes('body.nav-open'),
        'CSS should have body.nav-open selector'
      );
      assert.ok(
        css.includes('overflow: hidden') || css.includes('overflow:hidden'),
        'CSS body.nav-open should set overflow: hidden'
      );
    });

    it('has .footer-copyright styling', () => {
      assert.ok(
        css.includes('.footer-copyright'),
        'CSS should have .footer-copyright class'
      );
    });

    it('has prefers-reduced-motion media query', () => {
      assert.ok(
        css.includes('prefers-reduced-motion'),
        'CSS should have prefers-reduced-motion support'
      );
    });

    it('uses CSS variable for transitions', () => {
      assert.ok(
        css.includes('var(--transition'),
        'CSS should use --transition custom property'
      );
    });
  });

  // ── 4. Progressive enhancement / graceful degradation ──────────────
  describe('graceful degradation (no-JS baseline)', () => {
    it('all main content is in semantic HTML (renders without JS)', () => {
      assert.ok(html.includes('<h1'), 'H1 should exist');
      assert.ok(html.includes('<h2'), 'H2s should exist');
      assert.ok(html.includes('<table'), 'Tables should exist');
      assert.ok(html.includes('<pre>'), 'Code blocks should exist');
      assert.ok(html.includes('curl -fsSL'), 'Install command should be in HTML');
    });

    it('content sections have semantic heading structure', () => {
      // Check that there are section headings in the markup
      const h2Count = (html.match(/<h2/g) || []).length;
      assert.ok(h2Count >= 6, 'Page should have adequate h2 headings');
    });

    it('footer copyright has static fallback (not empty)', () => {
      assert.ok(
        html.includes('>2026<'),
        'Static copyright year 2026 should exist in HTML'
      );
    });

    it('CSS hamburger menu is styled without JS dependency', () => {
      assert.ok(
        css.includes('.nav-toggle:checked'),
        'CSS should handle nav toggle without JS via :checked selector'
      );
    });
  });

  // ── US-010: aria-current Accessibility ──────────────────────────────
  describe('aria-current attribute for active nav', () => {
    it('sets aria-current="page" on active nav link', () => {
      assert.ok(
        scriptsJs.includes("setAttribute('aria-current'") ||
        scriptsJs.includes('setAttribute("aria-current"'),
        'scripts.js should set aria-current="page" on active link'
      );
    });

    it('removes aria-current from non-active links', () => {
      assert.ok(
        scriptsJs.includes("removeAttribute('aria-current'") ||
        scriptsJs.includes('removeAttribute("aria-current"'),
        'scripts.js should remove aria-current from inactive links'
      );
    });

    it('sets aria-current to "page" value', () => {
      assert.ok(
        scriptsJs.includes("aria-current', 'page'") ||
        scriptsJs.includes('aria-current", "page"'),
        'aria-current should be set to "page"'
      );
    });
  });
});
