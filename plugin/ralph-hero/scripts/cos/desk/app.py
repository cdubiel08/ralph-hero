"""
cos — desk mode: Streamlit dashboard at localhost:8502

Six read-only panels:
  1. Today's Brief      — renders the latest morning-brief markdown
  2. Pipeline State     — horizontal bar chart of issues by workflow state
  3. KG Growth          — line chart of KG document count per day per memory_tier (30 days)
  4. Recent Activity    — table of last 20 activity events
  5. WIP                — table of In Progress / In Review issues with age
  6. KG Search          — text input → knowledge_search → top 5 results

Plus a Chat panel that shells out to cos.sh --role default (zero Claude Code).

Run with: ralph cos desk
Port: 8502 (not 8501 — avoids collision with other local Streamlit apps)

Zero-Claude-Code constraint: every chat message shells out to cos.sh.
This app NEVER calls the Anthropic SDK, OpenAI SDK, claude CLI, or any remote LLM.
"""

import glob
import json
import os
import sqlite3
import subprocess
import datetime
from pathlib import Path
from typing import Any, Optional

import pandas as pd
import streamlit as st

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

PORT = int(os.environ.get("RALPH_COS_DESK_PORT", 8502))

# Resolve repo root at startup — robust to working-dir changes
_git_result = subprocess.run(
    ["git", "rev-parse", "--show-toplevel"],
    capture_output=True,
    text=True,
    check=True,
)
REPO_ROOT = Path(_git_result.stdout.strip())

COS_SH = REPO_ROOT / "plugin" / "ralph-hero" / "scripts" / "cos" / "cos.sh"
THOUGHTS_DIR = Path(
    os.environ.get("RALPH_COS_THOUGHTS_DIR", str(REPO_ROOT / "thoughts"))
)
KG_DB = Path(os.path.expanduser("~/.ralph-hero/knowledge.db"))

# MCP server binaries
_MCP_HERO_BIN = REPO_ROOT / "plugin" / "ralph-hero" / "mcp-server" / "dist" / "index.js"
_MCP_KNOWLEDGE_BIN = REPO_ROOT / "plugin" / "ralph-knowledge" / "dist" / "index.js"


# ---------------------------------------------------------------------------
# MCP-stdio helper
# ---------------------------------------------------------------------------

def _call_mcp(
    tool_name: str,
    args: dict[str, Any],
    binary_path: Optional[Path] = None,
) -> Any:
    """
    Call an MCP tool via stdio JSON-RPC against a built MCP server binary.

    Spawns `node <binary>`, writes one JSON-RPC tools/call request to stdin,
    reads one response line from stdout, and returns the parsed content.

    Raises RuntimeError if the binary does not exist or the call fails.
    The ralph CLI does not have --json flags (verified: grep --json plugin/ralph-hero/scripts/ralph*
    returns empty), so this is the primary data path for Panels 2, 4, 5, and 6.
    """
    bin_path = binary_path or _MCP_HERO_BIN
    if not bin_path.exists():
        raise RuntimeError(
            f"MCP server not built: {bin_path}\n"
            "Run: cd plugin/ralph-hero/mcp-server && npm install && npm run build"
        )

    # Minimal JSON-RPC 2.0 envelope
    request = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": args,
        },
    })

    env = dict(os.environ)

    proc = subprocess.run(
        ["node", str(bin_path)],
        input=request + "\n",
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )

    if proc.returncode != 0:
        raise RuntimeError(f"MCP server exited {proc.returncode}: {proc.stderr[:500]}")

    # Parse first non-empty line of stdout that looks like JSON-RPC
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            response = json.loads(line)
        except json.JSONDecodeError:
            continue

        if "error" in response:
            raise RuntimeError(f"MCP error: {response['error']}")

        result = response.get("result", {})
        if result.get("isError"):
            content = result.get("content", [{}])
            raise RuntimeError(f"Tool error: {content[0].get('text', 'unknown')}")

        content = result.get("content", [{}])
        text = content[0].get("text", "") if content else ""
        try:
            return json.loads(text)
        except (json.JSONDecodeError, TypeError):
            return text

    raise RuntimeError("No parseable JSON-RPC response from MCP server")


# ---------------------------------------------------------------------------
# Panel 1 — Today's Brief
# ---------------------------------------------------------------------------

def render_brief() -> None:
    """Render the latest morning-brief markdown from thoughts/shared/research/."""
    st.subheader("Today's Brief")
    try:
        today = datetime.date.today().isoformat()
        brief_path = (
            THOUGHTS_DIR / "shared" / "research" / f"{today}-cos-morning-brief.md"
        )

        if brief_path.exists():
            st.markdown(brief_path.read_text())
        else:
            pattern = str(THOUGHTS_DIR / "shared" / "research" / "*-cos-morning-brief.md")
            matches = sorted(glob.glob(pattern))
            if matches:
                most_recent = Path(matches[-1])
                date_str = most_recent.name.split("-cos-morning-brief")[0]
                st.info(f"Showing brief from {date_str} (no brief for today yet)")
                st.markdown(most_recent.read_text())
            else:
                st.info(
                    "No morning brief found. "
                    "Run `ralph cos unattended --morning-brief` to generate one."
                )
    except Exception as e:
        st.error(f"Today's Brief: {e}")


# ---------------------------------------------------------------------------
# Panel 2 — Pipeline State
# ---------------------------------------------------------------------------

def render_pipeline() -> None:
    """Render a horizontal bar chart of issues by workflow state."""
    st.subheader("Pipeline State")
    refresh = st.button("Refresh pipeline", key="refresh_pipeline")

    @st.cache_data(ttl=300, show_spinner=False)
    def _fetch_pipeline() -> dict[str, Any]:
        return _call_mcp("ralph_hero__pipeline_dashboard", {})

    if refresh:
        _fetch_pipeline.clear()

    try:
        data = _fetch_pipeline()

        # Extract workflow state counts from the dashboard response
        # The pipeline_dashboard returns markdown text; parse the state counts from it
        if isinstance(data, str):
            # Markdown response — extract state count lines
            rows: list[dict[str, Any]] = []
            for line in data.splitlines():
                line = line.strip()
                # Look for lines like "| In Progress | 3 |" or similar table rows
                if line.startswith("|") and line.endswith("|"):
                    parts = [p.strip() for p in line.split("|") if p.strip()]
                    if len(parts) >= 2:
                        state_name = parts[0]
                        try:
                            count = int(parts[1])
                            if state_name not in ("State", "Workflow State", "---", ""):
                                rows.append({"state": state_name, "count": count})
                        except ValueError:
                            pass
            if rows:
                df = pd.DataFrame(rows).set_index("state")
                st.bar_chart(df)
            else:
                st.markdown(data)
        elif isinstance(data, dict):
            # pipeline_dashboard returns {phases: [{name, count, ...}, ...], ...}
            phases = data.get("phases", [])
            if phases and isinstance(phases, list):
                rows_dict: list[dict[str, Any]] = [
                    {"state": p.get("name", str(p)), "count": p.get("count", 0)}
                    for p in phases
                    if isinstance(p, dict)
                ]
                if rows_dict:
                    df = pd.DataFrame(rows_dict).set_index("state")
                    st.bar_chart(df)
                else:
                    st.json(data)
            else:
                st.json(data)
        else:
            st.write(data)
    except RuntimeError as e:
        err_str = str(e)
        if "not built" in err_str:
            st.warning(err_str)
        else:
            st.error(f"Pipeline State: {e}")
    except Exception as e:
        st.error(f"Pipeline State: {e}")


# ---------------------------------------------------------------------------
# Panel 3 — KG Growth
# ---------------------------------------------------------------------------

def render_kg_growth() -> None:
    """Render a line chart of KG document count per day per memory_tier (30 days)."""
    st.subheader("KG Growth")
    try:
        if not KG_DB.exists():
            st.warning(f"KG DB not available: {KG_DB} does not exist")
            return

        # Column is `date` (TEXT ISO-8601) — verified against plugin/ralph-knowledge/src/db.ts:104-113
        # There is NO `created_at` column. The outer date() is the SQLite function;
        # the inner `date` is the column name.
        con = sqlite3.connect(f"file:{KG_DB}?mode=ro", uri=True)
        try:
            df = pd.read_sql_query(
                """
                SELECT date(date) AS day, memory_tier, COUNT(*) AS count
                FROM documents
                WHERE date >= date('now', '-30 day')
                GROUP BY 1, 2
                ORDER BY 1
                """,
                con,
            )
        finally:
            con.close()

        if df.empty:
            st.info("No KG documents indexed in the last 30 days.")
            return

        # Pivot to wide format: one column per memory_tier
        pivot = df.pivot(index="day", columns="memory_tier", values="count").fillna(0)
        st.line_chart(pivot)
    except (sqlite3.OperationalError, sqlite3.ProgrammingError) as e:
        st.warning(f"KG DB not available: {e}")
    except Exception as e:
        st.error(f"KG Growth: {e}")


# ---------------------------------------------------------------------------
# Panel 4 — Recent Activity
# ---------------------------------------------------------------------------

def render_recent_activity() -> None:
    """Render a table of the last 20 activity events."""
    st.subheader("Recent Activity")
    try:
        data = _call_mcp(
            "ralph_hero__recent_activity",
            {"compact": True, "limit": 20},
        )

        if isinstance(data, list) and data:
            df = pd.DataFrame(data)
            # Keep only the columns we care about (compact mode projection)
            cols = [c for c in ["ts", "kind", "tool", "project"] if c in df.columns]
            st.dataframe(df[cols], use_container_width=True)
        elif isinstance(data, dict) and "events" in data:
            df = pd.DataFrame(data["events"])
            cols = [c for c in ["ts", "kind", "tool", "project"] if c in df.columns]
            st.dataframe(df[cols], use_container_width=True)
        elif isinstance(data, str):
            st.text(data)
        else:
            st.info("No recent activity.")
    except RuntimeError as e:
        err_str = str(e)
        if "not built" in err_str:
            st.warning(err_str)
        else:
            st.error(f"Recent Activity: {e}")
    except Exception as e:
        st.error(f"Recent Activity: {e}")


# ---------------------------------------------------------------------------
# Panel 5 — WIP
# ---------------------------------------------------------------------------

def render_wip() -> None:
    """Render a table of In Progress / In Review issues with assignee and age."""
    st.subheader("WIP")
    try:
        in_progress = _call_mcp(
            "ralph_hero__list_issues",
            {"workflowState": "In Progress", "limit": 50},
        )
        in_review = _call_mcp(
            "ralph_hero__list_issues",
            {"workflowState": "In Review", "limit": 50},
        )

        def _to_list(val: Any) -> list[dict[str, Any]]:
            if isinstance(val, list):
                return val
            if isinstance(val, dict) and "items" in val:
                return val["items"]
            if isinstance(val, dict) and "issues" in val:
                return val["issues"]
            return []

        items = _to_list(in_progress) + _to_list(in_review)

        if not items:
            st.info("No issues In Progress or In Review.")
            return

        now = datetime.datetime.now(datetime.timezone.utc)
        rows = []
        for item in items:
            updated_at = item.get("updatedAt") or item.get("updated_at", "")
            age_days = ""
            if updated_at:
                try:
                    updated_dt = datetime.datetime.fromisoformat(
                        updated_at.replace("Z", "+00:00")
                    )
                    age_days = (now - updated_dt).days
                except (ValueError, TypeError):
                    pass

            assignees = item.get("assignees", [])
            assignee_str = (
                assignees[0] if isinstance(assignees, list) and assignees else ""
            )
            if isinstance(assignee_str, dict):
                assignee_str = assignee_str.get("login", "")

            rows.append({
                "number": item.get("number", ""),
                "title": item.get("title", ""),
                "workflowState": item.get("workflowState", ""),
                "assignee": assignee_str,
                "age_days": age_days,
            })

        df = pd.DataFrame(rows)
        st.dataframe(df, use_container_width=True)
    except RuntimeError as e:
        err_str = str(e)
        if "not built" in err_str:
            st.warning(err_str)
        else:
            st.error(f"WIP: {e}")
    except Exception as e:
        st.error(f"WIP: {e}")


# ---------------------------------------------------------------------------
# Panel 6 — KG Search
# ---------------------------------------------------------------------------

def render_kg_search() -> None:
    """Render a KG search input and results table."""
    st.subheader("KG Search")
    try:
        query = st.text_input(
            "KG search query",
            placeholder="e.g., ralph-hero workflow states",
            key="kg_search_query",
        )
        if st.button("Search", key="kg_search_btn"):
            if not query.strip():
                st.warning("Enter a search query.")
                return

            if not _MCP_KNOWLEDGE_BIN.exists():
                st.warning(
                    "KG search requires the ralph-knowledge plugin to be built.\n"
                    "Run: cd plugin/ralph-knowledge && npm install && npm run build"
                )
                return

            results = _call_mcp(
                "knowledge_search",
                {"query": query, "limit": 5},
                binary_path=_MCP_KNOWLEDGE_BIN,
            )

            if isinstance(results, list) and results:
                df = pd.DataFrame(results)
                cols = [c for c in ["title", "type", "date", "score"] if c in df.columns]
                st.dataframe(df[cols], use_container_width=True)
            elif isinstance(results, dict) and "results" in results:
                df = pd.DataFrame(results["results"])
                cols = [c for c in ["title", "type", "date", "score"] if c in df.columns]
                st.dataframe(df[cols], use_container_width=True)
            else:
                st.info("No results found.")
    except RuntimeError as e:
        err_str = str(e)
        if "not built" in err_str:
            st.warning(err_str)
        else:
            st.error(f"KG Search: {e}")
    except Exception as e:
        st.error(f"KG Search: {e}")


# ---------------------------------------------------------------------------
# Chat panel
# ---------------------------------------------------------------------------

def render_chat() -> None:
    """
    Chat panel — shells out to cos.sh --role default (zero Claude Code).

    Streaming semantics: cos.sh is a single-prompt wrapper (non-streaming).
    It invokes pi non-interactively and prints the accumulated response when
    pi finishes. st.write_stream renders line-buffered / one-shot output,
    not token-by-token. A st.spinner conveys "waiting for the LLM".
    Token-by-token streaming is a Phase 6+ enhancement.

    Session history lives in st.session_state.messages (lost on tab refresh).
    No history is persisted to disk in Phase 5.
    """
    st.subheader("Chat")

    if "messages" not in st.session_state:
        st.session_state.messages = []

    # Render conversation history
    for msg in st.session_state.messages:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])

    prompt = st.chat_input("Ask cos anything...")

    if prompt:
        # Append + render user message
        st.session_state.messages.append({"role": "user", "content": prompt})
        with st.chat_message("user"):
            st.markdown(prompt)

        # Shell out to cos.sh
        if not COS_SH.exists():
            st.error(f"cos.sh not found: {COS_SH}")
            return

        collected_lines: list[str] = []

        def _line_generator():
            proc = subprocess.Popen(
                [str(COS_SH), "--role", "default", prompt],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
            )
            for line in proc.stdout:
                collected_lines.append(line)
                yield line
            proc.wait()
            if proc.returncode != 0:
                error_line = f"\n[cos.sh exited {proc.returncode}]\n"
                collected_lines.append(error_line)
                yield error_line

        with st.chat_message("assistant"):
            with st.spinner("Asking cos..."):
                st.write_stream(_line_generator())

        full_response = "".join(collected_lines)
        if f"\n[cos.sh exited" in full_response:
            st.error(full_response.split("\n[cos.sh exited")[-1].rstrip("]\n").lstrip(" "))
        else:
            st.session_state.messages.append(
                {"role": "assistant", "content": full_response}
            )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    # Exactly one st.set_page_config call — Streamlit throws StreamlitAPIException
    # if this is called more than once per app. Do NOT call it in any panel function.
    st.set_page_config(
        page_title="cos — desk",
        layout="wide",
        initial_sidebar_state="collapsed",
    )

    st.title("cos — desk")
    st.caption(
        f"Port {PORT} · zero Claude Code · chat routes through cos.sh → local LLM"
    )

    # Row 1: Today's Brief | Pipeline State | KG Growth
    col1, col2, col3 = st.columns(3)
    with col1:
        render_brief()
    with col2:
        render_pipeline()
    with col3:
        render_kg_growth()

    st.divider()

    # Row 2: Recent Activity | WIP | KG Search
    col4, col5, col6 = st.columns(3)
    with col4:
        render_recent_activity()
    with col5:
        render_wip()
    with col6:
        render_kg_search()

    st.divider()

    # Full-width Chat panel
    render_chat()


if __name__ == "__main__":
    main()
