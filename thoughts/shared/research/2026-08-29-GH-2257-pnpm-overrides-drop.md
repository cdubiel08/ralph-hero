---
date: 2026-08-29
issue: GH-2257
status: cause bounded, not attributed
---

# Why dependabot's regenerated remotion lockfile drops `overrides:`

## The observation

`plugin/ralph-demo/remotion/package.json` has carried
`pnpm.overrides.{"ws@<8.20.1": "^8.20.1"}` since 2026-08-01 (PR #1699, merge
`49e7bcca` — the `-S` search returns the merge, the line was authored on the
branch). PR **#2013** (dependabot, same group, same directory) merged
2026-08-16 and its lockfile diff **starts at `importers:`** — the `overrides:`
block was never touched. PR **#2081**, opened 2026-08-19, **deletes** it while
leaving `pnpm.overrides` in package.json. So this is a dated regression inside
a three-day window, not an inherent property of dependabot on pnpm.

## What was ruled out

Five pnpm versions were run against #2081's own `package.json`
(`pnpm install --lockfile-only --ignore-scripts`), both fresh and on top of
main's existing lockfile:

| pnpm | `overrides:` block | `supports-color@8.1.1` peer suffixes |
|---|---|---|
| 9.0.6 | preserved | 2 |
| 9.7.1 | preserved | 2 |
| 9.12.3 | preserved | 2 |
| 9.15.9 | preserved | 2 |
| 10.32.1 | preserved | 2 |
| main's lockfile (written by #2013) | present | 2 |
| **#2081 head `c0d4428`** | **absent** | **54** |

No reachable pnpm reproduces #2081's lockfile from the repo's real manifest.
**The pnpm-version hypothesis is dead.**

## What reproduces it exactly

Delete `pnpm.overrides` from package.json, regenerate, restore package.json —
the resulting lockfile header is exactly #2081's:

```diff
-overrides:
-  ws@<8.20.1: ^8.20.1
-
 importers:
```

## The second fingerprint

#2081's lockfile also hoists `supports-color@8.1.1` into 54 peer suffixes
(`'@babel/core@7.29.7(supports-color@8.1.1)'`, …). Main's lockfile and every
local regeneration have 2 occurrences and no suffix chain — while both files
record `settings: autoInstallPeers: true`. So dependabot's regeneration
environment differs from a plain `pnpm install` in more than the manifest it
was handed.

## What is NOT established

Which dependabot-core change did it. That is upstream and unobservable from
here — no dependabot run log exposes the manifest it fed to pnpm or the pnpm
build it vendored. **This is the reason the deliverable is a guard and not a
fix**: the repo cannot control the regeneration, only refuse to merge a
lockfile that lost a floor.

## Consequence for the acceptance criterion

"The security floor survives a lockfile regeneration" cannot be guaranteed
from inside this repo. What can be guaranteed is that a regeneration which
drops it is **loud** — `scripts/check-pnpm-overrides.sh`, run before the
frozen install in `build-and-test-demo`. The negative case is a lockfile that
would satisfy `--frozen-lockfile` while having quietly dropped an override,
which is what makes the guard independent of that check rather than redundant
with it.

Reproduction of every row above:
`scripts/__tests__/check-pnpm-overrides.test.sh` (fixtures), and for the live
file: `gh api "repos/cdubiel08/ralph-hero/contents/plugin/ralph-demo/remotion/pnpm-lock.yaml?ref=c0d4428980768ea603c00aea709def5ba6de5493"`.
