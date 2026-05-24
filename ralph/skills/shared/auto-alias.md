# auto-alias.md — Per-verb `--auto` alias for ralph slim plugin skills

Reference fragment. SKILL.md bodies copy the logic below; they do not source this file.

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

```
--auto is not supported for this verb (interactive / single-artifact / one-shot). See ralph/CLAUDE.md § Loop and --auto suitability matrix for the canonical table.
```

---

## Conflict detection

If `$ARGUMENTS` contains BOTH `--auto` AND an explicit `--mode <x>`, emit the following and STOP:

```
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
