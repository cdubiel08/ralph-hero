# UX Trends 2026 — Scoring Rubric

This rubric defines the 8 trend categories and the concrete, observable criteria for scores 1 through 5 in each. Use this to score a live website during a UX trend audit.

**Scoring philosophy:** Scores reflect what is *observable* in the captured screenshots and accessibility snapshots. Don't infer capabilities you can't see. A site that has great personalization on the backend but shows a static, one-size-fits-all page in the capture scores low on personalization — because that's the user's actual experience.

**Site type calibration:** Not every category carries the same weight for every site type. The "Relevance" note under each category indicates where a lower score is acceptable vs. where it signals a real gap.

---

## Table of Contents

1. [Layout Innovation](#1-layout-innovation)
2. [Color & Visual Direction](#2-color--visual-direction)
3. [Spatial & Motion Design](#3-spatial--motion-design)
4. [Accessibility Baseline](#4-accessibility-baseline)
5. [Multimodal Readiness](#5-multimodal-readiness)
6. [Personalization Signals](#6-personalization-signals)
7. [Agentic UX Readiness](#7-agentic-ux-readiness)
8. [AI Integration](#8-ai-integration)

---

## 1. Layout Innovation

How the site organizes content spatially. Evaluates grid systems, content hierarchy, navigation patterns, and willingness to break from conventional templates.

**Relevance:** High for marketing sites, portfolios, e-commerce. Medium for SaaS dashboards. Lower for docs sites and internal tools (where predictability is a feature).

| Score | Label | Observable Indicators |
|-------|-------|-----------------------|
| 1 | Conventional | Standard header/hero/3-column/footer. Bootstrap or template feel. No visual hierarchy beyond heading sizes. Cookie-cutter layout indistinguishable from thousands of other sites. |
| 2 | Structured | Clear visual hierarchy with intentional spacing. Some variation in section layouts. Responsive but formulaic — uses one grid rhythm throughout. Content blocks are organized but not distinctive. |
| 3 | Purposeful | Multiple grid rhythms across sections. Asymmetric layouts appear where content warrants it. Card-based or bento-style sections present but not dominant. Whitespace used as a design element, not just padding. Navigation has at least one non-standard element (sticky sidebar, breadcrumb trail, tab system). |
| 4 | Innovative | Bento grid layouts with varied cell sizes creating visual rhythm. Non-linear navigation patterns (radial menus, scroll-driven discovery, interactive site maps). Content density varies intentionally between sections. Layouts respond to content type, not just screen size. Hidden drawers or progressive disclosure for secondary content. |
| 5 | Pioneering | Layouts that feel like exploration rather than navigation. Spatial organization that breaks the vertical scroll paradigm (horizontal scrolling sections, map-based navigation, 3D space navigation). Multiple valid reading paths through content. Layout itself communicates brand identity — remove the logo and the layout is still recognizable. |

---

## 2. Color & Visual Direction

The site's color palette, use of gradients, contrast, and overall visual tone. Evaluates whether color is used as a communication tool or just decoration.

**Relevance:** High for consumer-facing sites, marketing, portfolios. Medium-high for SaaS. Lower for docs (where readability trumps expression).

| Score | Label | Observable Indicators |
|-------|-------|-----------------------|
| 1 | Minimal/Default | Grayscale with one accent color. Or: uncoordinated colors that feel accidental. No gradient usage. Colors don't carry semantic meaning beyond links. Feels like a wireframe that shipped. |
| 2 | Intentional | Coherent palette of 3-5 colors. Primary/secondary/accent distinction clear. Colors used consistently but conservatively. Flat design — no gradients, no depth through color. Dark mode either absent or a simple inversion. |
| 3 | Expressive | Saturated palette with confident choices. Gradients present (at least subtle ones). Color used to guide attention and create hierarchy. Dark/light mode both feel designed (not one as afterthought). Semantic color coding (success/warning/error) is distinct from brand palette. |
| 4 | Bold | "Dopamine design" influence — vibrant, high-energy palette that creates emotional response. Multi-stop gradients or color transitions between sections. Neon or high-saturation accents used strategically. Color palette shifts between sections to signal context changes. Micro-interactions use color change as feedback. |
| 5 | Distinctive | Color system tells a story — palette evolves through the user journey. Dynamic color that responds to context (time of day, user state, content type). Y2K/retro-futurist influence executed with sophistication. Glassmorphism, aurora gradients, or chromatic effects that enhance rather than distract. Color is the first thing you'd describe about this site. |

---

## 3. Spatial & Motion Design

Use of depth, 3D elements, animations, transitions, and scroll-driven effects. Evaluates whether the site feels flat and static or immersive and alive.

**Relevance:** High for marketing, portfolios, product launches. Medium for e-commerce (product visualization). Low for docs, internal tools (where motion can be distracting).

| Score | Label | Observable Indicators |
|-------|-------|-----------------------|
| 1 | Static | No animations beyond browser defaults. No scroll effects. Flat design with no depth cues. Page transitions are instant (no enter/exit animations). Hover states are basic color changes only. |
| 2 | Functional | CSS transitions on hovers and state changes. Basic fade-in on scroll for content sections. Subtle box shadows for depth. Loading spinners/progress indicators. Motion is present but purely functional — never decorative. |
| 3 | Engaging | Scroll-triggered animations that reveal content. Parallax effects on at least one section. Card hover effects with scale/shadow changes. Page transitions with enter/exit animations. Micro-interactions on buttons and form elements (subtle bounce, ripple, or glow). |
| 4 | Immersive | 3D elements rendered in the browser (WebGL, Three.js, or CSS 3D transforms). Interactive models the user can rotate/explore. Scroll-driven narrative that tells a story through motion. Physics-based animations (spring, momentum). Cursor-reactive elements (elements that respond to mouse position). |
| 5 | Experiential | Full 3D scenes or environments. AR preview capabilities. Spatial audio tied to UI interactions. Motion design that creates a sense of place — the site feels like a space you're in, not a page you're reading. Cinematic scroll experiences with choreographed multi-element animations. |

---

## 4. Accessibility Baseline

Whether the site treats accessibility as a first-class concern. This isn't a full WCAG audit (use `/ralph-playwright:a11y-scan` for that) — it evaluates whether accessibility thinking is visible in the design decisions.

**Relevance:** High for all site types. This is the one category where a low score is never acceptable regardless of context.

| Score | Label | Observable Indicators |
|-------|-------|-----------------------|
| 1 | Neglected | No alt text on images. Poor color contrast (light gray text on white). No visible focus indicators. Forms without labels. Heading hierarchy broken (h1 → h3 jumps). Interactive elements not keyboard-reachable. |
| 2 | Minimal | Some alt text present but generic ("image", "photo"). Contrast mostly adequate for body text but fails on subtle UI elements. Focus indicators present but browser-default (not styled). Basic heading hierarchy. Links distinguishable from text only by color. |
| 3 | Compliant | Alt text is descriptive and contextual. Contrast ratios meet AA (4.5:1 normal, 3:1 large). Custom focus indicators that are visible and on-brand. Proper heading hierarchy. Skip navigation link present. Form inputs have visible labels. Error messages associated with fields. |
| 4 | Proactive | AAA contrast ratios on primary content. Focus indicators are prominent and distinctive. Reduced motion respected (`prefers-reduced-motion`). High-contrast mode support. ARIA landmarks on all major sections. Live regions for dynamic content updates. Keyboard shortcuts for power users documented. |
| 5 | Exemplary | Accessibility is a visible design feature, not just compliance. Font size controls or display preferences exposed in UI. Screen reader experience feels curated (not just "doesn't break"). Voice navigation hints visible. Content adapts to user preferences (prefers-color-scheme, prefers-contrast, prefers-reduced-motion all handled). Error prevention patterns (confirmation, undo) throughout. |

---

## 5. Multimodal Readiness

Whether the site offers or is prepared for interaction modes beyond click/tap — voice, gesture, camera, or context-aware input switching. This is an emerging category; most sites score 1-2 here and that's expected.

**Relevance:** Medium for consumer apps, voice-assistant ecosystems. Low for most sites currently — but growing fast. A score of 2+ signals forward-thinking.

| Score | Label | Observable Indicators |
|-------|-------|-----------------------|
| 1 | Click-Only | Only mouse/touch interaction supported. No voice, no camera, no alternative input modes. Search is text-only. No input method adaptation. |
| 2 | Search-Enhanced | Voice search icon or microphone button visible. OR: camera/image search available. One alternative input mode offered but not deeply integrated — it's an add-on feature, not woven into the experience. |
| 3 | Mode-Aware | Multiple input modes available and contextually appropriate. Mobile experience adapts interaction patterns (swipe gestures, haptic feedback indicators). Input mode switching is smooth — voice search results display the same way as text search. Paste-from-clipboard or drag-and-drop accepted for file inputs. |
| 4 | Context-Adaptive | Interface adapts based on detected context: larger touch targets on mobile, keyboard shortcuts on desktop, voice affordances when no-hands detected. Smart input fields that adapt format hints. Copy/paste preserves formatting intelligently. QR codes or NFC-adjacent features for cross-device handoff. |
| 5 | Truly Multimodal | Seamless blending of voice, touch, and visual interaction throughout — not just in one feature. "Show and tell" interactions (point camera at something, get information). Interface responds to environmental signals (ambient light → dark mode, noise level → visual-heavy mode). Multiple modalities can be used simultaneously rather than switching between them. |

---

## 6. Personalization Signals

Whether the site adapts to individual users. Evaluated from what's observable — if the site shows the same content to everyone, it scores low regardless of what might be happening on the backend.

**Relevance:** High for e-commerce, SaaS dashboards, content platforms. Medium for marketing sites. Low for docs (where consistency is valued).

| Score | Label | Observable Indicators |
|-------|-------|-----------------------|
| 1 | One-Size | Identical experience for all users. No preferences, no history, no adaptation. Static content that doesn't acknowledge the user's context. "Sign up" shown even to logged-in users. |
| 2 | Segment-Based | Location-based content (currency, language). Basic "recommended for you" section. Recently viewed items shown. Greeting with username. Preferences limited to language/region. |
| 3 | Behavioral | Content order changes based on usage patterns. "Because you viewed X" recommendations. Personalized dashboard or home screen. Saved preferences persist across sessions. Notification preferences granular. Smart defaults based on past behavior. |
| 4 | Predictive | Content anticipated before request — "You might need this next" surfaced proactively. Dynamic UI that rearranges based on individual usage patterns (frequently used features promoted). Onboarding that adapts to demonstrated skill level. Time-aware content (different emphasis morning vs. evening). |
| 5 | Individualized | UI itself adapts — layout, density, navigation, and content all flex per user. AI-generated content summaries or digests tailored to user interests. Interfaces that learn and simplify over time. The site feels like it was built specifically for this user. |

---

## 7. Agentic UX Readiness

How well the site works for AI agents and automated tools — not just human users. This evaluates whether an AI assistant or agent could effectively navigate and extract value from the site. This is the breakout 2026 trend: sites will increasingly be consumed by agents acting on behalf of users.

**Relevance:** High for SaaS, APIs, e-commerce, content platforms. Medium for marketing sites. Growing for all categories.

| Score | Label | Observable Indicators |
|-------|-------|-----------------------|
| 1 | Human-Only | Content rendered entirely in images or Canvas. No semantic HTML. Critical information in PDFs or images without text alternatives. Interactive elements with no programmatic labels. SPAs with no URL state — agents can't link to or navigate to specific content. |
| 2 | Parseable | Semantic HTML present (headings, lists, tables used correctly). Content is in the DOM (not trapped in Canvas/SVG). URLs are meaningful and stable. Basic meta tags (title, description). Forms have labels. But structure is incidental — not designed for machine consumption. |
| 3 | Structured | Schema.org / JSON-LD structured data on key pages. OpenGraph and social meta tags complete. Clear URL patterns (RESTful-style). Breadcrumb navigation with markup. Sitemap.xml present and current. Content organized in predictable, queryable patterns. |
| 4 | Agent-Friendly | API documentation or endpoints discoverable from the site. Machine-readable content feeds (RSS, JSON feeds, API endpoints). Stable selectors (data-testid or semantic) that agents can rely on. Programmatic access to search and filtering. State changes reflected in URLs (agents can construct deep links). Content available without JavaScript rendering (SSR/SSG). |
| 5 | Agent-Native | Explicit AI/agent integration points — API keys, OAuth for agents, webhook endpoints. MCP server or tool-use endpoints. Content negotiation (HTML for humans, JSON for agents on the same URL). Agent-specific documentation or onboarding. Rate limiting that accommodates agent access patterns. The site treats agents as a first-class user type. |

---

## 8. AI Integration

Whether the site integrates AI capabilities into the user experience — chatbots, AI-assisted search, content generation, smart suggestions, or AI-powered features.

**Relevance:** High for SaaS, knowledge bases, content platforms. Medium for e-commerce (recommendations are AI even if not labeled). Lower for simple marketing sites.

| Score | Label | Observable Indicators |
|-------|-------|-----------------------|
| 1 | None | No AI features visible. Search is basic keyword matching. No suggestions, no chatbot, no smart features. |
| 2 | Basic AI | AI chatbot present (floating widget). OR: "AI-powered" search that returns better results than keyword matching. AI is a bolt-on feature — clearly separate from the core experience. Often branded as "Ask AI" or "AI Assistant". |
| 3 | Integrated | AI features woven into the workflow — inline suggestions, smart autocomplete, AI-generated summaries alongside content. AI helps without requiring the user to explicitly "ask AI". Copilot-style assistance that appears contextually. AI features are optional and don't hijack the experience. |
| 4 | AI-Enhanced | Multiple AI touchpoints throughout the experience. Content generation or transformation available (summarize, translate, reformat). AI-driven navigation ("show me items similar to this"). Personalized AI that learns from the user's history within the app. AI confidence indicators or source attribution shown. |
| 5 | AI-Native | AI is the primary interaction paradigm — the site is fundamentally an AI experience with UI around it, not a UI with AI bolted on. Natural language as a first-class navigation method. AI generates, curates, and adapts content in real-time. The distinction between "searching" and "asking" is eliminated. Human and AI contributions are seamlessly blended. |

---

## Scoring Guidance by Site Type

Use this to calibrate expectations — a score of 3 on personalization means different things for an e-commerce site vs. a docs site.

| Category | Marketing | E-Commerce | SaaS Dashboard | Docs | Internal Tool |
|----------|-----------|------------|----------------|------|---------------|
| Layout Innovation | 4-5 expected | 3-4 expected | 3 is fine | 2-3 is fine | 2 is fine |
| Color & Visual | 4-5 expected | 3-4 expected | 3 is fine | 2-3 is fine | 2 is fine |
| Spatial & Motion | 4-5 expected | 3 expected | 2-3 is fine | 1-2 is fine | 1-2 is fine |
| Accessibility | 4+ always | 4+ always | 4+ always | 4+ always | 3+ always |
| Multimodal | 2-3 forward | 3 expected | 2 is fine | 1-2 is fine | 1-2 is fine |
| Personalization | 2-3 is fine | 4-5 expected | 4 expected | 2-3 is fine | 3 expected |
| Agentic UX | 3 is fine | 3-4 expected | 4 expected | 4 expected | 2-3 is fine |
| AI Integration | 2-3 is fine | 3 expected | 3-4 expected | 3-4 expected | 2-3 is fine |

**Reading the table:** "expected" means a score below this signals a notable gap for this site type. "is fine" means a lower score is acceptable and improving it may not be the best use of resources.

---

## How to Use This Rubric

1. **Read each category definition** before scoring — don't just scan the table
2. **Look at the observable indicators** — match what you see in the screenshots, not what you imagine might be there
3. **Use the site type table** to contextualize — a docs site scoring 2 on Spatial Design is not a problem
4. **Score conservatively** — when in doubt, go lower. It's more useful to surface gaps than to be generous
5. **Note "Not Observed"** when you genuinely can't evaluate a category from the evidence (e.g., no logged-in state captured, so personalization can't be assessed)
6. **Cross-reference categories** — a site with great Accessibility (4+) and great Agentic UX (4+) is in strong shape regardless of where Spatial Design lands

*Last updated: March 2026. Trends shift — review and update this rubric quarterly.*
