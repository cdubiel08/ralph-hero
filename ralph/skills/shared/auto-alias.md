# auto-alias.md — Per-verb `--auto` alias for ralph slim plugin skills

Reference fragment, and the canonical source for all three sections below. Two different contracts apply, so the distinction is spelled out rather than left implicit:

- **§ Alias table and § Refusal targets are pointer-only.** No verb inlines a private copy of either; a verb's SKILL.md cites this file and reads the rows from here. Changing a row here changes behavior everywhere.
- **§ Step-0 stanza is a template that each verb DOES inline** into its own Step 0 (it has to — the stanza runs as part of the verb's own arg parsing). This file is its canonical wording; the inlined copies must match it, and `ralph/skills/shared/__tests__/auto-alias.test.sh` guards the refusal strings against drift.

---

## Alias table

`--auto` rewrites `$ARGUMENTS` to the verb's most autonomous mode before `--loop` detection runs.
`review` is already autonomous by default; no mode flag is added.

| Verb | `--auto` rewrites to |
|---|---|
| research | `--mode auto` |
| plan | `--mode auto` |
| impl | `--mode auto` |
| review | (no change; default mode is already an autonomous queue-drainer) |
| caretake | `--mode triage` |
| hero | `--mode auto` |

---

## Refusal targets

Verbs that refuse `--auto` entirely (interactive / single-artifact / one-shot):

- `form` — interactive picker with 3-5 AskUserQuestion calls
- `catch-up` — interactive orientation (default/narrative/dashboard modes)
- `setup` — one-shot bootstrap; no queue to drain

Refusal text (emit verbatim, then STOP):

```text
--auto is not supported for this verb (interactive / single-artifact / one-shot). See ralph/CLAUDE.md § Loop suitability for the canonical detail.
```

---

## Conflict detection

If `$ARGUMENTS` contains BOTH `--auto` AND an explicit `--mode <x>`, emit the following and STOP:

```text
--auto cannot be combined with explicit --mode; pick one.
```

---

## Step-0 stanza (copy into each alias-table verb's Step 0, ahead of `--loop` detection)

```bash
# --auto alias resolution (run BEFORE --loop detection)
if [[ "$ARGUMENTS" =~ (^|[[:space:]])--auto([[:space:]]|$) ]]; then
  if [[ "$ARGUMENTS" =~ (^|[[:space:]])--mode[[:space:]] ]]; then
    printf '%s\n' "--auto cannot be combined with explicit --mode; pick one."
    exit 0
  fi
  # Rewrite: remove --auto token, prepend resolved mode (verb-specific)
  ARGUMENTS="$(echo "$ARGUMENTS" | sed -E 's/(^|[[:space:]])--auto([[:space:]]|$)/\1/g' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  ARGUMENTS="--mode <RESOLVED_MODE> ${ARGUMENTS}"
fi
```

Replace `<RESOLVED_MODE>` per the alias table row for the verb being edited.
`review` skips the `--mode` prepend (default is already autonomous); just strip `--auto`.
