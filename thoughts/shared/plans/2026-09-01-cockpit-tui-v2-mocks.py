#!/usr/bin/env python3
"""ralph cockpit TUI mocks — round 2.

    python3 cockpit-mocks.py --glyphs nerd --width $(tput cols) --height $(tput lines) \\
        | LESSUTFCHARDEF='E000-F8FF:p,F0000-FFFFD:p' less -R

    --glyphs nerd|unicode|ascii   --only N (repeatable)   --wash "#111629" (selection wash)

Sections:
  0  baseline    today's render, for reference
  1  states      the status-dot vocabulary (done = filled green, idle = hollow, none = small dot)
  2  cost        $ in cash green, coin = tokens, context shown only as an alert
  3  legend      contextual legend, option A (unavailable verbs hidden)
  4  epic        the `e` popover: an epic and its children as board cards
  5  ink         time + [est] only; selection = white bar + subtle wash
  6  done        Done cards: green dot, purple merge glyph + closing PR
  7  feedback    liveness spinner, typed status line, in-flight column headers
  8  more        further options: age past TTL, whose-turn on In Review, stale lease, escalation audience, burn rate, filter
  9  everything  one pane-height frame, legend pinned to the bottom
"""
import argparse
import os
import re
import shutil
import textwrap
import unicodedata

ESC = "\x1b["
ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


def s(text, fg=None, bg=None, bold=False, italic=False, faint=False, strike=False, ul=False):
    codes = []
    if bold: codes.append("1")
    if faint: codes.append("2")
    if italic: codes.append("3")
    if ul: codes.append("4")
    if strike: codes.append("9")
    if fg is not None: codes.append(f"38;5;{fg}")
    if bg is not None: codes.append(f"48;5;{bg}")
    if not codes:
        return text
    return f"{ESC}{';'.join(codes)}m{text}{ESC}0m"


def vis(text):
    plain = ANSI_RE.sub("", text)
    w = 0
    for ch in plain:
        if unicodedata.east_asian_width(ch) in ("W", "F"): w += 2
        elif unicodedata.combining(ch): pass
        else: w += 1
    return w


def pad(text, to):
    d = to - vis(text)
    return text + (" " * d if d > 0 else "")


def trim(text, n):
    if vis(text) <= n:
        return text
    return text[: max(0, n - 1)] + "…"


def trunc(text, width):
    out, w, i = [], 0, 0
    while i < len(text):
        m = ANSI_RE.match(text, i)
        if m:
            out.append(m.group(0)); i = m.end(); continue
        ch = text[i]
        cw = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        if w + cw > width: break
        out.append(ch); w += cw; i += 1
    return "".join(out) + f"{ESC}0m"


# ── glyph tiers ─────────────────────────────────────────────────────────────
TIERS = {
    "nerd": dict(
        # written as escapes on purpose: the raw PUA characters were silently dropped by a file write once
        branch="", agents="", pr="", merge="", chevron="❯",
        usd="", token="", ctx="",
        starting="◌", working="●", reporting="◕", blocked="●", idle="○", done="●", none="·",  # unicode dots even in nerd mode
        p0="", ok="", err="", lock="", live="⠋", stalled="",
    ),
    "unicode": dict(
        branch="⎇", agents="×", pr="⇅", merge="⌥", chevron="❯",
        usd="$", token="¤", ctx="⛶",
        starting="◌", working="●", reporting="◕", blocked="●", idle="○", done="●", none="·",
        p0="!", ok="✓", err="✗", lock="⚿", live="⠋", stalled="◍",
    ),
    "ascii": dict(
        branch="", agents="x", pr="pr", merge="M", chevron=">",
        usd="$", token="tok", ctx="ctx",
        starting=".", working="*", reporting="o", blocked="*", idle="-", done="*", none=".",
        p0="!", ok="ok", err="!!", lock="L", live="|", stalled="x",
    ),
}
CURRENT = dict(branch="", agents="x", pr="⇅", merge="", chevron=">", usd="$", token="", ctx="",
               working="●", reporting="●", blocked="●", idle="○", done="○", starting="·", none="·", p0="P0",
               ok="✓", err="", lock="", live="", stalled="")

# ── ink ─────────────────────────────────────────────────────────────────────
INK = dict(
    num=15, text=15, branch=240, meta=240, rule=236, question=214, epic=60, timer=244,
    gutter=237, gutter_sel=15,
    dot_working=11, dot_reporting=75, dot_blocked=203, dot_idle=114, dot_done=114, dot_starting=244, dot_none=237,
    p0=203, p1=208, p2=220, p3=15,
    add=114, dele=203, sep=238, unread=242,
    pr_ready=114, pr_pending=214, pr_conflict=205, pr_merged=141, pr_closed=203,
    rollup=141, caret=141, colhead=250, colhead_sel=15, err=9,
    cash=65, token=180, ctx_warn=214, ctx_hot=203, live=114, stalled=214,
)
INK_CUR = dict(INK, p1=11, p2=15, caret=15, timer=244, meta=240)
INK_NEW = dict(INK, timer=246, est=246)
WASH = "#111629"

# ── data ────────────────────────────────────────────────────────────────────
EPIC = dict(num=2346, title="worker token economics", done=2, total=7)


def card(num, title, state, prio="P2", est="S", agent=None, age=None, age_min=0, diff=None, pr=None, epic=None,
         question=None, closed=None, cost=None, tokens=None, ctx=None, fleet=1, queue=None, verb=None,
         merged=None, turn=None, lease=None, esc_to=None):
    return dict(num=num, title=title, state=state, prio=prio, est=est,
                branch=f"feat/{num}-" + re.sub(r"[^a-z0-9]+", "-", title.lower())[:22].strip("-"),
                agent=agent, age=age, age_min=age_min, diff=diff, pr=pr, epic=epic, question=question, closed=closed,
                cost=cost, tokens=tokens, ctx=ctx, fleet=fleet, queue=queue, verb=verb, merged=merged, turn=turn,
                lease=lease, esc_to=esc_to)


IN_PROGRESS = [
    card(2366, "worktree leases outlive the session that took them", "In Progress", "P1", "S", agent="reporting", age="1h 12m", age_min=72, diff=(212, 38), epic=EPIC, cost=2.41, ctx=151),
    card(2367, "transition releases the lease it cannot see", "In Progress", "P0", "S", agent="working", age="41m", age_min=41, diff=(96, 12), cost=1.18, ctx=98),
    card(2347, "ledger usage fact + worker session id", "In Progress", "P1", "S", agent="working", age="2h 38m", age_min=158, diff=(340, 15), epic=EPIC, cost=3.72, ctx=172, lease="stale"),
    card(2350, "per-lane model setting at the harness-args builder", "In Progress", "P2", "S", agent="working", age="37m", age_min=37, diff=(0, 0), epic=EPIC, cost=0.62, ctx=71, fleet=2),
    card(2359, "fork.sh forks the wrong pane under a split", "In Progress", "P3", "XS", agent="starting", age="2m", age_min=2, diff=None, cost=0.31, ctx=59),
    card(2372, "cockpit: contextual legend and state glyphs", "In Progress", "P2", "M", agent=None),
]
IN_REVIEW = [
    card(2340, "board brief shows the answered-unresumed window", "In Review", "P2", "S", pr=("ready", 2371), cost=4.10, turn="ready"),
    card(2312, "kit-sync asserts byte identity on the workflow half", "In Review", "P2", "XS", pr=("pending", 2369), agent="idle", age="2h 05m", age_min=125, cost=1.95, ctx=133, turn="bot reviewing"),
    card(2298, "doctor state-guard line names the cause", "In Review", "P1", "M", pr=("conflict", 2355), cost=6.80, turn="yours: rebase"),
    card(2255, "containment is two layers, not one", "In Review", "P1", "M", pr=("merged", 2358), cost=9.14, turn="close out"),
    card(2331, "readiness: integration-policy recommendation", "In Review", "P3", "S", pr=None, cost=None),
]
HUMAN = [
    card(2353, "babysitter judgment boundary in deliver/tend", "Human Needed", "P2", "S", agent="blocked", age="3h 40m", age_min=220, epic=EPIC, cost=5.22, ctx=164,
         question="Sonnet on deliver only, deliver+tend, or neither? Recommend A.", esc_to="lead"),
    card(2301, "release-ralph tags the pre-rebase commit", "Human Needed", "P1", "S", agent=None,
         question="Rotate ROUTING_PAT now or wait for the 14:00 reset?", esc_to="inbox"),
]
DONE = [
    card(2338, "board who is machine-wide", "Done", closed="3h 12m", cost=2.02, merged=2361),
    card(2320, "card line 2 is the title again", "Done", closed="1d 02h 40m", cost=0.88, merged=2333),
    card(2294, "cmdscan: one reader for all four rails", "Done", closed="4d 11h 03m", cost=7.35, merged=2299),
    card(2288, "cancel: superseded by the SQLite ledger", "Done", closed="5d 01h 10m", cost=None, merged=None),
]
INBOX = [
    card(2353, "babysitter judgment boundary in deliver/tend", "Inbox", "P2", "S", queue="decision", question="Sonnet on deliver only, deliver+tend, or neither? Recommend A.", verb="board answer 2353 -m"),
    card(2360, "cancel: superseded by the SQLite ledger", "Inbox", "P3", "XS", queue="proposal", verb="board resolve 2360 --accept|--reject"),
]
EPIC_CHILDREN = [
    card(2347, "ledger usage fact + worker session id", "In Progress", "P1", "S", agent="working", age="2h 38m", age_min=158, diff=(340, 15), cost=3.72),
    card(2350, "per-lane model setting at the harness-args builder", "In Progress", "P2", "S", agent="working", age="37m", age_min=37, diff=(0, 0), cost=0.62, fleet=2),
    card(2348, "work skill emits a finished exit", "Backlog", "P2", "XS"),
    card(2349, "prefix fingerprint hook attributes the rewrites", "Backlog", "P2", "S"),
    card(2351, "split CLAUDE.md; first-call cache write drops", "Backlog", "P2", "M"),
    card(2352, "model A/B on cost per closed issue", "Backlog", "P2", "S"),
    card(2353, "babysitter judgment boundary in deliver/tend", "Human Needed", "P2", "S", agent="blocked", age="3h 40m", age_min=220, cost=5.22, question="Sonnet on deliver only, deliver+tend, or neither?"),
    card(2345, "measure the fleet's spend anatomy", "Done", closed="1d 04h", cost=1.40, merged=2346),
    card(2344, "price the 279 worker transcripts", "Done", closed="1d 06h", cost=0.55, merged=2346),
]


# ── card renderer ───────────────────────────────────────────────────────────
def dot(state, g, ink):
    if state is None:
        return s(g["none"], fg=ink["dot_none"])
    k = {"working": "working", "reporting": "reporting", "blocked": "blocked", "idle": "idle",
         "done": "done", "starting": "starting"}.get(state, "none")
    return s(g[k], fg=ink["dot_" + k])


def prio(p, g, ink):
    if p == "P0":
        return pad(s(g["p0"], fg=ink["p0"], bold=True), 2)
    if p == "P1": return s("P1", fg=ink["p1"])
    if p == "P2": return s("P2", fg=ink["p2"])
    if p == "P3": return s("P3", fg=ink["p3"])
    return s("P?", fg=ink["p0"])


def diff_chip(c, ink):
    if c["agent"] is None: return ""
    if c["diff"] is None: return s("±?", fg=ink["unread"])
    a, d = c["diff"]
    return s(f"+{a}", fg=ink["add"]) + s("/", fg=ink["sep"]) + s(f"-{d}", fg=ink["dele"])


def pr_chip(c, g, ink):
    if c["pr"] is None: return ""
    fate, n = c["pr"]
    lab = f"{g['pr']} #{n}" if g["pr"] != "pr" else f"pr#{n}"
    return {"ready": s(lab, fg=ink["pr_ready"]), "pending": s(lab, fg=ink["pr_pending"]),
            "conflict": s(lab + "!", fg=ink["pr_conflict"]), "merged": s(lab, fg=ink["pr_merged"]),
            "closed": s(lab, fg=ink["pr_closed"])}[fate]


def merge_chip(c, g, ink):
    if not c.get("merged") or not g["merge"]: return ""
    lab = f"{g['merge']} #{c['merged']}" if g["merge"] != "M" else f"M#{c['merged']}"
    return s(lab, fg=ink["pr_merged"])


def cost_chip(c, g, ink):
    if c["cost"] is None:
        return s(f"{g['usd']}—", fg=ink["unread"]) if c["agent"] else ""
    return s(f"{g['usd']}{c['cost']:.2f}", fg=ink["cash"], italic=True)


def ctx_chip(c, g, ink, always=False):
    k = c["ctx"]
    if k is None or (k < 120 and not always): return ""
    col = ink["dot_idle"] if k < 120 else ink["ctx_warn"] if k < 160 else ink["ctx_hot"]
    return s(f"{g['ctx']}{k}k", fg=col)


def age_chip(c, g, ink, ttl_warn=False):
    lab = c["age"] or "—"
    col = ink["ctx_warn"] if (ttl_warn and c["age_min"] > 120 and c["agent"]) else ink["timer"]
    return s(lab, fg=col)


def epic_chip(c, g, ink, budget):
    e = c["epic"]
    if not e: return ""
    head = s(g["chevron"], fg=ink["caret"]) + " " + s(f"#{e['num']}", fg=ink["epic"], italic=True)
    if vis(head) > budget: return ""
    tally = f"{e['done']}/{e['total']}"
    rest = budget - vis(head) - len(tally) - 1
    if rest < 0: return head
    # the title is all-or-nothing: a trimmed "worke…" reads as a different issue
    if e["title"] and rest - 1 >= vis(e["title"]):
        head += " " + s(e["title"], fg=ink["epic"], italic=True)
    return head + " " + s(tally, fg=ink["rollup"])


def render_card(c, width, g, ink, *, selected=False, wash=None, cost=False, ctx_always=False, ttl_warn=False,
                turn=False, lease=False, esc=False, state_tag=False, cur=False):
    inner = width - 2
    bar = "▌" if selected else "│"
    bar_s = s(bar, fg=15, bold=True) if selected else s(bar, fg=ink["gutter"])
    num_s = s(f"#{c['num']}", fg=ink["num"], bold=selected)

    left = num_s
    if c["fleet"] > 1:
        left += " " + s(f"{g['agents']}{c['fleet']}", fg=ink["dot_working"])
    if lease and c.get("lease") == "stale":
        left += " " + s(g["lock"], fg=ink["ctx_warn"])
    chip = ""
    if state_tag:
        chip = s(c["state"], fg=ink["meta"])
    elif c["state"] == "In Progress":
        chip = diff_chip(c, ink)
    elif c["state"] == "In Review":
        chip = pr_chip(c, g, ink)
    elif c["state"] == "Done":
        chip = merge_chip(c, g, ink)
    elif c["state"] == "Human Needed" and esc and c.get("esc_to"):
        chip = s("→ " + c["esc_to"], fg=ink["question"])
    elif c["state"] == "Inbox" and c["queue"]:
        chip = s(c["queue"], fg=ink["question"] if c["queue"] == "decision" else ink["meta"])
    avail = inner - vis(left) - 2 - (vis(chip) + 2 if chip else 0)
    line1 = left
    if c["state"] not in ("Inbox", "Backlog") and avail > 3:
        br = c["branch"]
        if g["branch"]: br = g["branch"] + " " + br
        line1 += "  " + s(trim(br, avail), fg=ink["branch"])
    if chip:
        line1 = pad(line1, inner - vis(chip)) + chip

    line2 = s(trim(c["title"], inner), fg=ink["text"], bold=selected)

    if c["state"] == "Done":
        l3 = s(f"closed {c['closed']} ago", fg=ink["meta"])
        right = cost_chip(c, g, ink) if cost and c["cost"] is not None else ""
        line3 = pad(l3, inner - vis(right)) + right if right else l3
    elif c["state"] == "Human Needed" or (c["state"] == "Inbox" and c["queue"] == "decision"):
        q = c["question"] or "(question unavailable — a still answers via the board)"
        line3 = s(trim("? " + q, inner), fg=ink["question"], italic=True)
    elif c["state"] == "Inbox":
        line3 = s(trim("→ " + c["verb"], inner), fg=ink["meta"])
    else:
        lead = prio(c["prio"], g, ink) + " " + s(f"[{c['est']}]", fg=ink.get("est", ink["meta"]))
        rp = []
        if turn and c.get("turn"): rp.append(s(c["turn"], fg=ink["pr_ready"] if c["turn"] == "ready" else ink["meta"]))
        if cost: rp += [x for x in (cost_chip(c, g, ink), ctx_chip(c, g, ink, ctx_always)) if x]
        if c["state"] != "Backlog": rp.append(age_chip(c, g, ink, ttl_warn))
        right = "  ".join(rp)
        ep = epic_chip(c, g, ink, inner - vis(lead) - vis(right) - 4)
        if ep: lead += "  " + ep
        line3 = pad(lead, inner - vis(right)) + right

    if cur and c["state"] == "Done":
        top = s("·", fg=237)
    else:
        top = dot("done" if c["state"] == "Done" else c["agent"], g, ink)
    rule = s("  " + "─" * max(1, width - 4), fg=ink["rule"])
    rows = [trunc(top + " " + line1, width), trunc(bar_s + " " + line2, width), trunc(bar_s + " " + line3, width), trunc(rule, width)]
    if selected and wash:
        rows = [bgwash(r, width, wash) if i < 3 else r for i, r in enumerate(rows)]
    return rows


def bgcode(bg):
    if isinstance(bg, str) and bg.startswith("#"):
        r, g_, b = int(bg[1:3], 16), int(bg[3:5], 16), int(bg[5:7], 16)
        return f"{ESC}48;2;{r};{g_};{b}m"
    return f"{ESC}48;5;{bg}m"


def bgwash(row, width, bg):
    code = bgcode(bg)
    row = pad(row, width).replace(f"{ESC}0m", f"{ESC}0m{code}")
    return code + row + f"{ESC}0m"


def render_column(title, cards, width, g, ink, *, sel_idx=None, col_ink=220, cursor_col=False, total=None,
                  header_note=None, **kw):
    name = s(title, fg=ink["colhead_sel"], bold=True) if cursor_col else s(title, fg=ink["colhead"])
    right = s(str(len(cards)), fg=col_ink, bold=True)
    if total is not None:
        right = s(f"{g['usd']}{total:.2f}", fg=ink["cash"], italic=True) + "  " + right
    if header_note:
        right = header_note + "  " + right
    rows = [trunc(pad(name, width - vis(right) - 2) + "  " + right, width),
            trunc(s("━" * min(width - 2, 60), fg=ink["rule"]), width)]
    if not cards:
        rows.append(s("  (none)", faint=True))
    for i, c in enumerate(cards):
        rows += render_card(c, width, g, ink, selected=(i == sel_idx), **kw)
    return rows


def join_cols(cols, gap=1):
    h = max(len(c) for c in cols)
    out = []
    for r in range(h):
        parts = []
        for c in cols:
            w = max(vis(x) for x in c)
            parts.append(pad(c[r] if r < len(c) else "", w))
        out.append((" " * gap).join(parts))
    return out


# ── sections ────────────────────────────────────────────────────────────────
W, H, GL = 150, 40, "unicode"


def H_(title, sub=None):
    print(); print(s("═" * W, fg=60))
    print(s(f"  {title}", fg=15, bold=True) + (s(f"   {sub}", fg=245) if sub else ""))
    print(s("═" * W, fg=60))


def note(text):
    for line in textwrap.wrap(text, max(40, W - 4)):
        print(s("  " + line, fg=245, italic=True))


def blank(): print()
def colw(): return (W - 2) // 3


def legend_for(kind, g):
    table = {
        "in-progress-live": [("⏎", "observe"), ("␣", "peek"), ("r", "reply"), ("f", "fork"), ("d", "diff"), ("e", "epic"), ("g", "browser")],
        "in-progress-live-noepic": [("⏎", "observe"), ("␣", "peek"), ("r", "reply"), ("f", "fork"), ("d", "diff"), ("g", "browser")],
        "in-progress-none": [("s", "spawn"), ("d", "diff"), ("g", "browser")],
        "in-progress-fleet": [("⏎", "observe w-lane"), ("␣", "peek"), ("r", "reply"), ("d", "diff"), ("e", "epic"), ("g", "browser")],
        "in-review-pr": [("d", "diff"), ("s", "spawn"), ("g", "browser")],
        "human-needed-live": [("a", "answer"), ("r", "reply"), ("⏎", "observe"), ("␣", "peek"), ("e", "epic"), ("g", "browser")],
        "human-needed-none": [("a", "answer"), ("g", "browser")],
        "done": [("g", "browser"), ("d", "diff"), ("D", "back to Human Needed")],
        "inbox-decision": [("a", "answer"), ("g", "browser")],
        "inbox-proposal": [("g", "browser")],
        "empty": [],
        "no-herdr": [("g", "browser"), ("d", "diff")],
    }[kind]
    parts = []
    for i, (k, v) in enumerate(table):
        key = s(k, fg=15, bold=True)
        parts.append(key + " " + (s(v, fg=15, bold=True) if i == 0 else s(v, fg=250)))
    return s(" · ", fg=240).join(parts) if parts else s("(no card — views only)", fg=240)


LEGEND_NAV = "h/l j/k move · v dag · T topology · i inbox · D done · I inbox-col · q quit"


def header_line(g, ink, live=True, stats=True):
    spin = s(g["live"], fg=ink["live"]) if live else s(g["stalled"] + " stale 4m", fg=ink["stalled"])
    t = s("ralph cockpit — ralph-hero", bold=True) + "  " + spin
    if stats:
        extra = (s(f"{g['working']} 4", fg=11) + "  " + s(f"{g['reporting']} 1", fg=75) + "  " + s(f"{g['blocked']} 1", fg=203)
                 + "  " + s(f"{g['starting']} 1", fg=246) + "  " + s(f"{g['idle']} 1", fg=114)
                 + "   " + s(f"{g['usd']}40.48 today", fg=ink["cash"], italic=True) + "  " + s(f"{g['token']} 3.1M", fg=ink["token"])
                 + "  " + s(f"{g['usd']}6.20/h", fg=ink["cash"], italic=True) + "  " + s("gql 3,812", fg=245))
        t = pad(t, W - vis(extra)) + extra
    return trunc(t, W)


def section_baseline():
    H_("0 · BASELINE", "today's render at this width")
    print(trunc(s("ralph cockpit — ralph-hero", bold=True) + s("  polled 12:04:11 · every 20s", faint=True), W)); print()
    cw = colw()
    cols = [render_column("In Progress", IN_PROGRESS[:5], cw, CURRENT, INK_CUR, sel_idx=1, col_ink=220, cursor_col=True, cur=True),
            render_column("In Review", IN_REVIEW[:4], cw, CURRENT, INK_CUR, col_ink=208, cur=True),
            render_column("Human Needed", HUMAN, cw, CURRENT, INK_CUR, col_ink=203, cur=True)]
    for r in join_cols(cols): print(trunc(r, W))
    print()
    print(s("h/l col · j/k card · ⏎ observe · ␣/o peek · r reply · a answer · s spawn · f fork · v dag · T topology · i inbox · d diff · D done⇄human · I inbox⇄human · g browser · q quit", faint=True))
    print("spawning a work session for #2359…")


def section_states():
    H_("1 · STATE VOCABULARY", "done = filled green, idle = hollow green, none = small dot; blocked stays a red dot")
    rows = [
        ("starting", "pane exists, no self-report yet (spawned/briefed)", ("·", 244), "starting", 246),
        ("working", "live motion — herdr sees the process moving", ("●", 11), "working", 11),
        ("reporting", "the session's close-out: PR opened, evidence posted, handing back", ("●", 75), "reporting", 75),
        ("blocked", "escalated — a human or the lead holds the answer", ("●", 203), "blocked", 203),
        ("idle", "alive, waiting for input — nothing is happening", ("○", 114), "idle", 114),
        ("done", "herdr `done` / the GH-2348 `finished` exit — over, cleanly", ("○", 114), "done", 114),
        ("none", "no live agent for this card", ("·", 237), "none", 237),
    ]
    print(s(f"  {'state':<11}{'means':<70}{'current':<10}{'unicode':<10}{'nerd':<10}{'ascii'}", fg=245))
    for st, means, cur, key, col in rows:
        line = f"  {s(st, bold=True):<20}{means:<70}" + pad(s(cur[0], fg=cur[1]), 10)
        for tier in ("unicode", "nerd", "ascii"):
            line += pad(s(TIERS[tier][key], fg=col), 10)
        print(line)
    blank()
    note("Reporting: the blue flag is gone. It means 'the worker is finishing — writing the PR, posting evidence, about to hand back'. Unicode ◕ (a circle nearly full); nerd is a paper plane (sending it off). If the stage itself is not worth a glyph, it collapses into working and the card simply goes green when the session ends.")
    note("Done and working are now both filled dots and differ by colour only (green vs yellow) — as asked. Idle is the hollow green; none is the small grey dot.")
    blank()
    cw = colw()
    samples = [
        card(2359, "starting", "In Progress", "P3", "XS", agent="starting", age="2m", diff=None, cost=0.31),
        card(2367, "working", "In Progress", "P0", "S", agent="working", age="41m", diff=(96, 12), cost=1.18),
        card(2366, "reporting", "In Progress", "P1", "S", agent="reporting", age="1h 12m", diff=(212, 38), cost=2.41),
        card(2353, "blocked", "In Progress", "P2", "S", agent="blocked", age="3h 40m", diff=(40, 2), cost=5.22),
        card(2312, "idle", "In Progress", "P2", "XS", agent="idle", age="2h 05m", diff=(18, 4), cost=1.95),
        card(2338, "done", "In Progress", "P2", "S", agent="done", age="55m", diff=(120, 9), cost=2.02),
        card(2372, "none", "In Progress", "P2", "M", agent=None),
    ]
    cols = [render_column(f"In Progress · {t}", samples, cw, TIERS[t], INK_NEW, col_ink=220, cost=True, cursor_col=(t == GL)) for t in ("unicode", "nerd", "ascii")]
    for r in join_cols(cols): print(trunc(r, W))
    blank()
    note("Priority on line 3: P0 is a red bang glyph (nerd fa-exclamation; plain ! elsewhere — no triple-bang exists in either font; ‼ is available if you want two), P1 orange, P2 yellow, P3 white.")


def section_cost():
    H_("2 · COST", "$ in a faded green, italic; the coin means TOKENS and lives in the header; context appears only as an alert past 120k")
    g, ink, cw = TIERS[GL], INK_NEW, colw()
    cols = [render_column("In Progress", IN_PROGRESS[:5], cw, g, ink, sel_idx=2, col_ink=220, cursor_col=True, cost=True, total=8.24),
            render_column("In Review", IN_REVIEW[:4], cw, g, ink, col_ink=208, cost=True, total=21.99),
            render_column("Done · 14d", DONE, cw, g, ink, col_ink=141, cost=True, total=10.25)]
    for r in join_cols(cols): print(trunc(r, W))
    blank()
    note(f"#2366 (151k) and #2347 (172k) carry the context alert; #2367 at 98k shows nothing. Unread cost is {g['usd']}— in grey; a card with no session shows no chip at all.")
    note("The epic title is all-or-nothing now: #2366 has room for '#2346 2/7' but not the title, so the title is dropped rather than trimmed to 'worke…'.")
    blank()
    print("  " + header_line(g, ink))
    note(f"Header stats: fleet by state, then {g['usd']}40.48 today (cash green), {g['token']} 3.1M tokens (the coin), {g['usd']}6.20/h burn rate, the GraphQL budget. The spinner after the title is the liveness signal (section 7).")


def section_legend():
    H_("3 · CONTEXTUAL LEGEND", "option A — unavailable verbs are hidden; the status line names the reason on a refused press")
    g, ink = TIERS[GL], INK_NEW
    cases = [
        ("In Progress · one live worker, in an epic", IN_PROGRESS[0], "in-progress-live", "In Progress", 220),
        ("In Progress · one live worker, no epic", IN_PROGRESS[1], "in-progress-live-noepic", "In Progress", 220),
        ("In Progress · no live agent", IN_PROGRESS[5], "in-progress-none", "In Progress", 220),
        ("In Progress · fleet of 2", IN_PROGRESS[3], "in-progress-fleet", "In Progress", 220),
        ("In Review · PR ready, no live agent", IN_REVIEW[0], "in-review-pr", "In Review", 208),
        ("Human Needed · blocked worker still up", HUMAN[0], "human-needed-live", "Human Needed", 203),
        ("Human Needed · no session", HUMAN[1], "human-needed-none", "Human Needed", 203),
        ("Done · closed by a PR", DONE[0], "done", "Done · 14d", 141),
        ("Inbox · decision row", INBOX[0], "inbox-decision", "Inbox", 203),
        ("Inbox · proposal row", INBOX[1], "inbox-proposal", "Inbox", 203),
        ("no herdr on this host", IN_PROGRESS[1], "no-herdr", "In Progress", 220),
    ]
    cw = colw() + 12
    for title, c, kind, col, colink in cases:
        print(s(f"  ▸ {title}", fg=250, bold=True))
        for r in render_column(col, [c], cw, g, ink, sel_idx=0, col_ink=colink, cursor_col=True, cost=True)[2:5]:
            print("    " + trunc(r, W - 4))
        print("    " + legend_for(kind, g))
        print("    " + s(LEGEND_NAV, fg=240))
        blank()
    note("`e epic` appears only on a card with a parent. Overlay legends: peek → 'esc close · r reply · ⏎ observe · j/k scroll'; epic → 'esc close · j/k child · ⏎ observe · ␣ peek · g browser'.")


def render_epic_overlay(g, ink, width, sel=0):
    innerW = width - 6
    e = EPIC
    title = (s(f"epic #{e['num']} — {e['title']}", bold=True) + "  " + s(f"{e['done']}/{e['total']} done", fg=ink["rollup"])
             + "  " + s(f"{g['usd']}14.84", fg=ink["cash"], italic=True) + "  " + s("2 live · 1 blocked · 4 backlog · 2 done", fg=245))
    cw = (innerW - 1) // 2
    left = [c for i, c in enumerate(EPIC_CHILDREN) if i % 2 == 0]
    right = [c for i, c in enumerate(EPIC_CHILDREN) if i % 2 == 1]
    lc = []
    for i, c in enumerate(left):
        lc += render_card(c, cw, g, ink, selected=(i * 2 == sel), wash=WASH, cost=True, state_tag=True)
    rc = []
    for i, c in enumerate(right):
        rc += render_card(c, cw, g, ink, selected=(i * 2 + 1 == sel), wash=WASH, cost=True, state_tag=True)
    body = join_cols([lc, rc], gap=1)
    lines = [trunc(title, innerW)] + [trunc(b, innerW) for b in body]
    top = s("╭" + "─" * (innerW + 2) + "╮", fg=245)
    bot = s("╰" + "─" * (innerW + 2) + "╯", fg=245)
    out = [top]
    for l in lines:
        out.append(s("│ ", fg=245) + pad(l, innerW) + s(" │", fg=245))
    out.append(bot)
    return out


def section_epic():
    H_("4 · THE `e` POPOVER", "an epic and every child as a board card, in the same state vocabulary; ⏎/␣/g act on the selected child")
    g, ink = TIERS[GL], INK_NEW
    for r in render_epic_overlay(g, ink, W, sel=0): print(r)
    blank()
    note("Children in board order: In Progress, Backlog, Human Needed, Done. The right slot on line 1 is the child's board STATE — the one fact that differs from the column view, where the column already says it. Each dot is the child's live agent state, exactly as on the board.")
    note("Backlog children have no agent and no age, so line 3 is priority + estimate only. Done children carry the merge glyph and the closing PR. The title row totals the epic's spend and its state tally, which is the rollup `board frontier` already computes plus the transcript join.")
    note("Data cost: one `board get <epic> --json` (children ride the issue fetch) — no new GraphQL shape.")


def section_ink():
    H_("5 · INK + SELECTION", "only the time and the [est] change (244/240 → 246); selection = the white bar as today, plus a subtle wash")
    g, cw = TIERS[GL], colw()
    a = render_column("current ink", IN_PROGRESS[:3], cw, g, INK_CUR, sel_idx=1, col_ink=220, cursor_col=True, cost=True)
    b = render_column("time + [est] only", IN_PROGRESS[:3], cw, g, INK_NEW, sel_idx=1, col_ink=220, cursor_col=True, cost=True)
    c = render_column(f"+ wash {WASH}", IN_PROGRESS[:3], cw, g, INK_NEW, sel_idx=1, col_ink=220, cursor_col=True, cost=True, wash=WASH)
    for r in join_cols([a, b, c]): print(trunc(r, W))
    blank()
    note(f"The wash is colour {WASH} — rerun with --wash 234 / 236 / 17 (a navy) to compare on your background. It paints the three content rows only, never the rule, so the card's geometry is unchanged.")


def section_done():
    H_("6 · DONE CARDS", "filled green dot; purple merge glyph + the PR that closed the issue; a close with no PR shows no chip")
    g, ink, cw = TIERS[GL], INK_NEW, colw()
    a = render_column("Done · 14d — today", DONE, cw, CURRENT, INK_CUR, sel_idx=0, col_ink=141, cursor_col=True, cur=True)
    b = render_column("Done · 14d — proposed", DONE, cw, g, ink, sel_idx=0, col_ink=141, cursor_col=True, cost=True, total=10.25)
    for r in join_cols([a, b], gap=4): print(trunc(r, W))
    blank()
    note("The closing PR is `closedByPullRequestsReferences` — the field the Done gate and the tend audit already read, so a Done card with no merge glyph IS the no-closing-keyword population the audit exists for (#2288 above). Nerd: octicon git-merge; unicode ⌥ (single-cell, reads as a merge); ascii M#.")


def section_feedback():
    H_("7 · FEEDBACK", "a liveness spinner, a typed status line, in-flight column headers")
    g, ink = TIERS[GL], INK_NEW
    print("  " + header_line(g, ink, live=True))
    print("  " + header_line(g, ink, live=False))
    note(f"Live: the spinner after the title turns while polls land on cadence. Stalled: it stops and goes amber with the age of the last successful poll ('{g['stalled']} stale 4m'). No 'polled HH:MM:SS · every Ns' text.")
    blank()
    samples = [
        (s(g["live"], fg=11) + " spawning a work session for #2359…", "in flight"),
        (s(g["ok"], fg=114) + " delivered to w2367", "succeeded"),
        (s(g["err"], fg=203) + " #2340 is In Review — a answers Human Needed cards", "refused, reason verbatim"),
        (s(g["blocked"], fg=214) + " no live agent for #2372 — s spawns one", "a nudge, amber"),
        (s("·", fg=240) + " " + s("third column: Human Needed", fg=246), "view change, dim"),
        (s(g["err"], fg=203) + " board read failed: exit 75 rate-limited — next poll after the 13:00 reset", "transient, names the retry"),
    ]
    for line, why in samples:
        print("  " + pad(line, 90) + s(why, fg=245, italic=True))
    blank()
    cw = colw()
    a = render_column("In Review", IN_REVIEW[:2], cw, g, ink, col_ink=208, cost=True, header_note=s(g["live"] + " signals", fg=240))
    b = render_column("Done · 14d", [], cw, g, ink, col_ink=141)
    b[2] = s("  (reading the last 14d…)", faint=True)
    c = render_column("Human Needed", HUMAN, cw, g, ink, col_ink=203, cost=True, header_note=s("stale 4m", fg=214))
    for r in join_cols([a, b, c]): print(trunc(r, W))
    note("Left of the count: a spinner while that column's read is out; 'stale Nm' in amber when the last read failed and these are the last good cards.")


def section_more():
    H_("8 · MORE OPTIONS", "each is one line of code on data the cockpit already has or one script it already ships")
    g, ink, cw = TIERS[GL], INK_NEW, colw()

    print(s("  ▸ age past the claim TTL goes amber", fg=250, bold=True))
    for r in render_column("In Progress", [IN_PROGRESS[2], IN_PROGRESS[1]], cw + 10, g, ink, col_ink=220, cost=True, ttl_warn=True): print("    " + trunc(r, W - 4))
    note("RALPH_LOCK_TTL_MIN is 120: a live agent older than the claim TTL is the one doctor's stale-claim sweep will demote. The age already sits on the card; it just changes ink.")
    blank()

    print(s("  ▸ In Review: whose turn (pr-gate-watch's verdict, not a new read)", fg=250, bold=True))
    for r in render_column("In Review", IN_REVIEW[:4], cw + 10, g, ink, col_ink=208, cost=True, turn=True): print("    " + trunc(r, W - 4))
    note("The PR chip says the PR's fate; this says the next actor: ready (green), bot reviewing, yours: attest / rebase / review, close out (merged, board move pending). It is the classifier `pr-gate-watch.sh` already prints, one word.")
    blank()

    print(s("  ▸ stale worktree lease on the card", fg=250, bold=True))
    for r in render_column("In Progress", [IN_PROGRESS[2]], cw + 10, g, ink, col_ink=220, cost=True, lease=True): print("    " + trunc(r, W - 4))
    note("The GH-1956 lock beside the agent count, only when its checkout is gone or its clock is past TTL — the fact the topology view spells as 'lease STALE', on the card where the verb is.")
    blank()

    print(s("  ▸ Human Needed: where the decision is", fg=250, bold=True))
    for r in render_column("Human Needed", HUMAN, cw + 10, g, ink, col_ink=203, cost=True, esc=True): print("    " + trunc(r, W - 4))
    note("`board escalations` already classifies every Human Needed item: → lead (inside the lead's window), → inbox (promoted or TTL'd), → human. On the card, the right slot of line 1 — the one slot Human Needed cards leave empty today.")
    blank()

    print(s("  ▸ `/` filter", fg=250, bold=True))
    print("    " + s("/ ", fg=15, bold=True) + "lease" + s("█", fg=15) + "   " + s("3 cards match · esc clears", fg=245))
    note("A substring over number, title, branch and agent name; non-matching cards are dimmed, not removed, so the grid does not move under the mouse.")
    blank()
    print(s("  ▸ `1`–`9` jump to the Nth visible card in the cursor column", fg=250, bold=True))
    note("Free keys today. With j/k that is at most two presses to any visible card.")


def section_everything():
    H_("9 · EVERYTHING TOGETHER", f"one pane-height frame ({H} rows), legend pinned to the bottom — tier {GL}")
    g, ink, cw = TIERS[GL], INK_NEW, colw()
    frame_h = H - 3
    body = []
    body.append(header_line(g, ink, live=True))
    body.append("")
    cols = [render_column("In Progress", IN_PROGRESS, cw, g, ink, sel_idx=0, col_ink=220, cursor_col=True, cost=True, total=8.24, wash=WASH),
            render_column("In Review", IN_REVIEW, cw, g, ink, col_ink=208, cost=True, total=21.99),
            render_column("Human Needed", HUMAN, cw, g, ink, col_ink=203, cost=True, total=5.22)]
    body += [trunc(r, W) for r in join_cols(cols)]
    footer = [s("on #2366  ", fg=240) + legend_for("in-progress-live", g),
              s(LEGEND_NAV, fg=240),
              s(g["ok"], fg=114) + " delivered to w2367"]
    room = frame_h - len(footer)
    body = body[:room]
    while len(body) < room: body.append("")
    for r in body + footer: print(r)


def section_wash():
    H_("10 · WASH GALLERY", "the same selected card under every wash; background is Tokyo Night Clear #0b1020")
    g, ink = TIERS[GL], INK_NEW
    cards = [IN_PROGRESS[0], IN_PROGRESS[1], IN_PROGRESS[2]]
    options = [
        ("no wash (bar + bold only)", None),
        ("256 · 233  #121212", 233), ("256 · 234  #1c1c1c", 234), ("256 · 235  #262626", 235),
        ("navy +3   #0e1326", "#0e1326"), ("navy +6   #111629", "#111629"), ("navy +9   #14192d", "#14192d"), ("navy +13  #181d33", "#181d33"),
        ("navy +18  #1d2239", "#1d2239"), ("blue tint #0f1a33", "#0f1a33"), ("256 · 17  #00005f", 17), ("256 · 232 #080808 (darker than bg)", 232),
    ]
    cw = (W - 3) // 4
    for i in range(0, len(options), 4):
        cols = []
        for title, wash in options[i:i + 4]:
            cols.append(render_column(title, cards, cw, g, ink, sel_idx=1, col_ink=220, cost=True, wash=wash))
        for r in join_cols(cols): print(trunc(r, W))
        blank()
    note("The navy steps are the terminal background lifted by N units per channel, so they read as 'the same colour, slightly lit' rather than a grey slab. +6 to +9 is where the eye still catches it from across the room; +3 is nearly subliminal. The 256 greys carry a grey cast on navy; 233 is the closest of them.")
    note("Rerun with --wash '#111629' (quote the hash) or --wash 233 to set the default for the full frame.")


SECTIONS = [("baseline", section_baseline), ("states", section_states), ("cost", section_cost), ("legend", section_legend),
            ("epic", section_epic), ("ink", section_ink), ("done", section_done), ("feedback", section_feedback),
            ("more", section_more), ("everything", section_everything), ("wash", section_wash)]


def main():
    global W, H, GL, WASH
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--glyphs", choices=list(TIERS), default="unicode")
    ap.add_argument("--width", type=int); ap.add_argument("--height", type=int)
    ap.add_argument("--wash", default="#111629", help="256 index or #rrggbb (default: navy +6 over Tokyo Night Clear)")
    ap.add_argument("--only", action="append"); ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    if a.list:
        for i, (n, _) in enumerate(SECTIONS): print(f"{i}  {n}")
        return
    GL = a.glyphs
    WASH = a.wash if str(a.wash).startswith("#") else int(a.wash)
    ts = shutil.get_terminal_size((150, 40))
    W = a.width or min(ts.columns, 200)
    H = a.height or ts.lines
    wanted = None
    if a.only:
        wanted = {SECTIONS[int(x)][0] if x.isdigit() else x for x in a.only}
    for name, fn in SECTIONS:
        if wanted is None or name in wanted: fn()
    print()


if __name__ == "__main__":
    main()
