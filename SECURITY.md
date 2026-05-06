# Security Policy

`ralph-hero` is a public [Claude Code plugin](https://docs.anthropic.com/en/docs/claude-code/plugins) that publishes the [`ralph-hero-mcp-server`](https://www.npmjs.com/package/ralph-hero-mcp-server) and [`ralph-knowledge`](https://www.npmjs.com/package/ralph-knowledge) packages to npm. We take security issues in those packages, the plugin code, and the supporting workflows seriously.

## Supported Versions

Both npm packages are auto-released on every merge to `main`, so only the **current major version** of each package receives security fixes. Pin to the latest minor of the current major to stay supported.

| Package | Supported |
|---------|-----------|
| `ralph-hero-mcp-server` | Current major only (latest published version) |
| `ralph-knowledge` | Current major only (latest published version) |

Older majors are not patched. If a vulnerability is found in a previous major, the fix will land in the current major and users should upgrade.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/cdubiel08/ralph-hero/security) of this repository.
2. Click **Report a vulnerability**.
3. Fill out the advisory form with as much detail as you can (affected package/version, reproduction steps, impact assessment, and any suggested mitigation).

### Response SLA

- **Acknowledgement**: within **7 days** of submission.
- **Triage and remediation timeline**: communicated in the advisory thread after triage.
- **Disclosure**: coordinated through the GitHub Security Advisory once a fix is available and published to npm.

## Branch Protection

The `main` branch is protected. Detailed branch protection rules (required checks, review requirements, signed commits, etc.) will be documented here when [#1031](https://github.com/cdubiel08/ralph-hero/issues/1031) (S4: Audit and document main branch protection) lands.

## CodeQL

GitHub's [CodeQL default setup](https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning) is enabled for this repository. There are currently no path exclusions; CodeQL scans the full tree on every push and pull request to `main`. See [#1029](https://github.com/cdubiel08/ralph-hero/issues/1029) (S2: Enable CodeQL default setup) for the enabling change and any future path-exclusion rationale.

## Dependency Management

Dependency updates are managed by [Dependabot](https://docs.github.com/en/code-security/dependabot). The configuration lives in [`.github/dependabot.yml`](.github/dependabot.yml) and covers npm and GitHub Actions ecosystems. Dependabot **security updates** are enabled, so vulnerable transitive dependencies are auto-flagged and PRs opened automatically. See [#1028](https://github.com/cdubiel08/ralph-hero/issues/1028) (S1: Enable Dependabot version + security updates) for the enabling change.
