<!-- BEGIN ralph-kit -->
## ralph merge gates — operator asks

Answer these from the installed gate family (`.github/ralph-kit.json` is the
install stamp) — don't re-derive:

- **"is this PR ready / whose turn is it"** → `bash scripts/pr-gate-watch.sh <PR> --watch`
  — run after **every** push; it classifies whose turn it is and exits on the
  first terminal verdict (`GATE-YOURS` / `GATE-FAIL` / `GATE-READY` / `GATE-DONE`).
- **"merge this PR"** → `bash scripts/merge-pr.sh <PR>` — never bare
  `gh pr merge`; the script IS the gate.
- **"attest this PR"** → `bash scripts/attest-pr.sh <PR> --run "<verify cmd>" ...`
  — the `ralph-attestation` status is pending **by design** until this runs.
- **Never wait on a PR with a `gh pr checks` poll loop** — `ralph-attestation`
  stays pending until attested, so the loop cannot terminate and its silence
  reads like CI still running. Use `pr-gate-watch.sh --watch` instead.

Policy lives in `.github/ralph-merge-policy.json`. Re-run the plugin's
`install-gates.sh` after a plugin update to pick up gate fixes; files you
modified locally are never overwritten without `--force`.
<!-- END ralph-kit -->
