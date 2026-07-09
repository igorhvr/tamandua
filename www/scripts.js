// Tamandua Website Scripts — Progressive Enhancements
// All JS is vanilla, wrapped in DOMContentLoaded, with feature support checks.

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  // ── 1. Dynamic Copyright Year ──────────────────────────────────────

  var yearEl = document.getElementById('copyright-year');
  if (yearEl) {
    yearEl.textContent = new Date().getFullYear();
  }

  // ── 2. Active Nav Link Highlighting (scroll-based) ─────────────────

  (function () {
    var navLinks = document.querySelectorAll('#nav-links a[href^="#"]');
    var sections = [];
    navLinks.forEach(function (link) {
      var id = link.getAttribute('href');
      if (!id || id === '#') return;
      var section = document.querySelector(id);
      if (section) {
        sections.push({ link: link, section: section });
      }
    });

    if (!sections.length) return;

    // Throttled scroll handler
    var ticking = false;
    function updateActiveLink() {
      var scrollPos = window.scrollY + 120; // offset for sticky header
      var active = null;

      for (var i = 0; i < sections.length; i++) {
        var s = sections[i];
        if (s.section.offsetTop <= scrollPos) {
          active = s;
        }
      }

      sections.forEach(function (s) {
        s.link.classList.remove('active');
        s.link.removeAttribute('aria-current');
      });
      if (active) {
        active.link.classList.add('active');
        active.link.setAttribute('aria-current', 'page');
      }
    }

    window.addEventListener('scroll', function () {
      if (!ticking) {
        window.requestAnimationFrame(function () {
          updateActiveLink();
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });

    // Initial call
    updateActiveLink();
  })();

  // ── 3. Smooth Scroll Navigation ────────────────────────────────────

  (function () {
    document.querySelectorAll('a[href^="#"]').forEach(function (anchor) {
      anchor.addEventListener('click', function (e) {
        var targetId = this.getAttribute('href');
        if (!targetId || targetId === '#') return;

        // Skip hamburger checkbox label (CSS-only menu)
        if (this.parentElement && this.parentElement.tagName === 'LABEL') return;

        var target = document.querySelector(targetId);
        if (!target) return;

        e.preventDefault();

        // Close mobile nav if open
        var navCheckbox = document.getElementById('nav-toggle');
        if (navCheckbox) {
          navCheckbox.checked = false;
          document.body.classList.remove('nav-open');
        }

        // Smooth scroll with offset for sticky header
        var headerHeight = document.querySelector('header');
        var offset = headerHeight ? headerHeight.offsetHeight + 8 : 0;
        var targetPosition = target.getBoundingClientRect().top + window.pageYOffset - offset;

        if ('scrollBehavior' in document.documentElement.style) {
          window.scrollTo({ top: targetPosition, behavior: 'smooth' });
        } else {
          window.scrollTo(0, targetPosition);
        }

        // Update URL hash without jump
        history.pushState(null, null, targetId);
      });
    });
  })();

  // ── 4. Intersection Observer Reveal Animations ─────────────────────

  (function () {
    if (!('IntersectionObserver' in window)) return;

    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            revealObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );

    document.querySelectorAll('.section-reveal').forEach(function (section) {
      revealObserver.observe(section);
    });
  })();

  // ── 5. Copy-to-Clipboard Buttons ───────────────────────────────────

  (function () {
    if (!('clipboard' in navigator) || typeof navigator.clipboard.writeText !== 'function') return;

    // Create copy button element
    function createCopyBtn() {
      var btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.setAttribute('aria-label', 'Copy code to clipboard');
      btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
        '<path d="M5 2V1h8v9h-1V2H5z" fill="currentColor"/>' +
        '<path d="M3 4h7v10H3V4zm1 1v8h5V5H4z" fill="currentColor"/>' +
        '</svg>' +
        '<span class="copy-btn-feedback" aria-hidden="true">Copied!</span>';
      btn.setAttribute('type', 'button');
      return btn;
    }

    // Find all code blocks that contain install commands or example commands
    // Target pre elements that are inside install sections, hero, or contain curl/git commands
    var codeBlocks = [];
    var allPres = document.querySelectorAll('pre');

    allPres.forEach(function (pre) {
      var text = pre.textContent || '';
      var isCommand = (
        text.indexOf('curl ') !== -1 ||
        text.indexOf('tamandua ') !== -1 ||
        text.indexOf('git clone') !== -1 ||
        text.indexOf('./build') !== -1 ||
        text.indexOf('./install') !== -1 ||
        text.indexOf('npm ') !== -1
      );
      if (isCommand) {
        codeBlocks.push(pre);
      }
    });

    codeBlocks.forEach(function (pre) {
      var btn = createCopyBtn();
      var copiedTimeout = null;
      // Make pre relatively positioned to contain the button
      pre.style.position = 'relative';

      btn.addEventListener('click', function () {
        var codeEl = pre.querySelector('code');
        // Prefer the full original text when an animation is mid-replay
        var text = codeEl
          ? (codeEl.__fullText || codeEl.textContent)
          : pre.textContent;
        var trimmed = text.replace(/^\n+/, '').replace(/\n+$/, '');

        navigator.clipboard.writeText(trimmed).then(function () {
          btn.classList.add('copied');
          btn.setAttribute('aria-label', 'Copied!');
          if (copiedTimeout) clearTimeout(copiedTimeout);
          copiedTimeout = setTimeout(function () {
            btn.classList.remove('copied');
            btn.setAttribute('aria-label', 'Copy code to clipboard');
            copiedTimeout = null;
          }, 2000);
        }).catch(function () {
          // Clipboard write failed — silently ignore (graceful degradation)
        });
      });

      pre.appendChild(btn);
    });
  })();

  // ── 7. Lightweight Syntax Highlighting (shell + YAML) ──────────────

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightShellLine(line, blockHasPrompt) {
    var html = escapeHtml(line);

    // Full-line comments
    if (/^\s*#/.test(line)) {
      return '<span class="tok-comment">' + html + '</span>';
    }

    var isPromptLine = /^\$\s/.test(line);
    var isCommand = isPromptLine || !blockHasPrompt;

    if (isCommand && line.trim() !== '') {
      // Strings first, then flags (flags in our content never sit inside strings)
      html = html.replace(/"([^"]*)"/g, '<span class="tok-str">"$1"</span>');
      html = html.replace(/(^|\s)(--?[a-zA-Z][\w-]*)/g, function (m, pre2, flag) {
        return pre2 + '<span class="tok-flag">' + flag + '</span>';
      });
      if (isPromptLine) {
        html = html.replace(/^\$/, '<span class="tok-prompt">$</span>');
      }
      return html;
    }

    // Output lines: colour status markers and success ticks
    html = html
      .replace(/\[done\s*\]/g, '<span class="tok-done">$&</span>')
      .replace(/\[running\]/g, '<span class="tok-run">$&</span>')
      .replace(/\[pending\]/g, '<span class="tok-pend">$&</span>')
      .replace(/\[failed\s*\]/g, '<span class="tok-fail">$&</span>')
      .replace(/✓/g, '<span class="tok-done">✓</span>');
    return '<span class="tok-output">' + html + '</span>';
  }

  function highlightYamlLine(line) {
    var html = escapeHtml(line);
    if (/^\s*#/.test(line)) return '<span class="tok-comment">' + html + '</span>';
    html = html.replace(/^(\s*(?:-\s+)?)([\w.-]+)(:)/, function (m, indent, key, colon) {
      return indent + '<span class="tok-key">' + key + '</span>' + colon;
    });
    html = html.replace(/&quot;[^&]*&quot;|"[^"]*"/g, function (m) {
      return '<span class="tok-str">' + m + '</span>';
    });
    return html;
  }

  function highlightedLines(codeEl) {
    var raw = codeEl.textContent;
    var lines = raw.split('\n');
    var isYaml = codeEl.classList.contains('language-yaml');
    var blockHasPrompt = /^\$\s/m.test(raw);
    return lines.map(function (line) {
      return {
        raw: line,
        html: isYaml ? highlightYamlLine(line) : highlightShellLine(line, blockHasPrompt)
      };
    });
  }

  (function () {
    document.querySelectorAll('pre > code').forEach(function (codeEl) {
      var pre = codeEl.parentElement;
      // Animated terminals are highlighted during replay (section 8)
      if (pre.parentElement && pre.parentElement.hasAttribute('data-terminal-animate')) return;
      var lines = highlightedLines(codeEl);
      codeEl.innerHTML = lines.map(function (l) { return l.html; }).join('\n');
    });
  })();

  // ── 8. Hero Terminal Cursor Blink ──────────────────────────────────
  // The hero terminal has a static cursor that blinks via CSS animation.
  // No JS replay needed — the terminal content is pre-rendered in HTML.

  // ── 6. Mobile Nav Toggle (JS enhancement over CSS checkbox) ────────

  (function () {
    var navToggle = document.getElementById('nav-toggle');
    if (!navToggle) return;

    // Close on outside click
    document.addEventListener('click', function (e) {
      if (!navToggle.checked) return;
      var nav = document.querySelector('nav');
      var target = e.target;
      // Close if click is outside the nav
      if (nav && !nav.contains(target)) {
        navToggle.checked = false;
      }
    });

    // Close on Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && navToggle.checked) {
        navToggle.checked = false;
        // Return focus to hamburger button
        var label = document.querySelector('.nav-toggle-label');
        if (label) label.focus();
      }
    });

    // Toggle body class for scroll lock when menu is open
    navToggle.addEventListener('change', function () {
      if (navToggle.checked) {
        document.body.classList.add('nav-open');
        // Focus trap: move focus to first nav link
        var firstLink = document.querySelector('#nav-links a');
        if (firstLink) {
          setTimeout(function () { firstLink.focus(); }, 100);
        }
      } else {
        document.body.classList.remove('nav-open');
      }
    });

    // Trap focus within open nav
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab' || !navToggle.checked) return;
      var links = document.querySelectorAll('#nav-links a');
      if (!links.length) return;
      var firstLink = links[0];
      var lastLink = links[links.length - 1];

      if (e.shiftKey && document.activeElement === firstLink) {
        e.preventDefault();
        lastLink.focus();
      } else if (!e.shiftKey && document.activeElement === lastLink) {
        e.preventDefault();
        firstLink.focus();
      }
    });
  })();

});
