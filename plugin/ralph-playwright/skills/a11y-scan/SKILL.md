---
name: ralph-playwright:a11y-scan
description: Run a standalone WCAG 2.2 AA accessibility audit against a URL or set of URLs using axe-core via a11y-accessibility. Reports violations by severity. Use for a quick a11y check without running full story execution. Requires a11y-accessibility to be registered.
---

# A11y Scan — Standalone Accessibility Audit

## Prerequisites
`a11y-accessibility` registered in Claude Code (see `/ralph-playwright:setup`).

## Process

### Step 1: Target URL(s)
From arguments or ask. Multiple URLs run in parallel.

### Step 2: Run axe-core checks
For each URL:
```
test_accessibility(url)         → WCAG rule violations
check_color_contrast(url)       → contrast ratios
check_aria_attributes(url)      → ARIA validity
```

### Step 3: Report
```
== A11y Scan: http://localhost:3000/login ==
WCAG 2.2 AA | axe-core | 3 violations

🔴 CRITICAL (1):
  - Interactive element not keyboard accessible: .modal-close-btn
    → Add tabindex="0" and keydown handler (WCAG 2.1.1)

🟠 SERIOUS (1):
  - Form field missing label: <input id="email">
    → Add <label for="email"> or aria-label (WCAG 1.3.1)

🟡 MODERATE (1):
  - Color contrast insufficient: .helper-text ratio 2.8:1, needs 4.5:1
    → Darken text color (WCAG 1.4.3)
```

Severities: 🔴 critical, 🟠 serious, 🟡 moderate, ⚪ minor.
