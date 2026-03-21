---
name: ralph-playwright:visual-diff
description: Run visual regression testing using Chromatic (default, free tier available) or Applitools Eyes (AI-based, better for dynamic content). Detects unintended UI changes across Storybook stories. Use after visual changes to verify intentional vs unintentional diffs.
---

# Visual Diff — Visual Regression Testing

## Tool Detection
Check what's configured:
```bash
cat package.json | grep -E "chromatic|@applitools"
```

- `chromatic` found → **Chromatic mode** (pixel-perfect)
- `@applitools/eyes-storybook` found → **Applitools mode** (AI-based)
- Neither → guide through Chromatic setup (recommended default)

## Chromatic (default)
```bash
npm install --save-dev chromatic
```

Before running Chromatic, get your project token from https://www.chromatic.com and set it as an environment variable:
```bash
export CHROMATIC_PROJECT_TOKEN=your-token-here
```

Then run:
```bash
npx chromatic
```
Free tier: 5,000 snapshots/month. Pixel-perfect diffing. Good for stable UIs.

## Applitools Eyes (alternative)
```bash
npm install --save-dev @applitools/eyes-storybook
npx eyes-storybook
```
AI-powered visual perception. Ignores rendering noise (anti-aliasing, sub-pixel differences). Better for UIs with dynamic content or cross-browser inconsistencies.

## When to choose Applitools over Chromatic
- Getting excessive false positives from Chromatic on animations or dynamic content
- Need cross-browser visual comparison (Chromatic uses one browser)
- Have Storybook stories with real data that varies slightly between runs
