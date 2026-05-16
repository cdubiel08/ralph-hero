"""Cloud Monitoring → GitHub Projects board bridge.

Pulls messages from a Cloud Monitoring → Pub/Sub subscription and
normalises each alert payload into a ``watcher-auto``-labeled draft
issue on the GitHub Projects V2 board.

Design constraints (from Feature D shared constraints):
- NO LLM calls. Mapping is deterministic: alert fields → issue fields.
- The ``<!-- gcp-policy: <id> -->`` marker shape matches what
  ``gcp-incident-triage`` already keys off — keeping the Director →
  Watch handoff stable without coordination.
- Idempotency: pre-flight checks for an open issue with the same
  policy-id marker via ``gh issue list``; skips creation if found.
- iOS-friendly issue body: one-paragraph summary, ``## Source``,
  ``## Suggested Team: watchers``, full alert JSON in ``<details>``.

Run via ``uv run subscribe.py --help`` for options.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger("ralph.monitoring-bridge.subscribe")

# ---------------------------------------------------------------------------
# Alert payload normalisation
# ---------------------------------------------------------------------------

_POLICY_ID_RE = re.compile(
    r"alertPolicies/([^/\"'\s]+)",
)


def _extract_policy_id(incident: dict[str, Any]) -> str:
    """Extract a stable policy id from the incident dict.

    Tries (in order):
    1. ``incident.policy_name`` — ``projects/<proj>/alertPolicies/<id>``
    2. ``incident.metadata.system_labels.links[].href`` — alert console URL
    3. ``incident.incident_id`` — fallback (unique per alert occurrence)
    """
    policy_name = incident.get("policy_name", "")
    m = _POLICY_ID_RE.search(policy_name)
    if m:
        return m.group(1)

    # Try the links array in system_labels
    links = (
        incident.get("metadata", {})
        .get("system_labels", {})
        .get("links", [])
    )
    for link in links:
        href = link.get("href", "")
        m = re.search(r"alertpolicies/detail/([^/?&#]+)", href, re.IGNORECASE)
        if m:
            return m.group(1)

    # Last resort: use the incident_id (unique per occurrence, not per policy)
    incident_id = incident.get("incident_id", "")
    if incident_id:
        return incident_id

    # Absolute fallback: deterministic hash of the whole incident JSON
    return hashlib.sha256(
        json.dumps(incident, sort_keys=True).encode()
    ).hexdigest()[:16]


def _build_alert_url(incident: dict[str, Any]) -> str:
    """Return the Cloud Console alert URL or a synthetic one."""
    url = incident.get("url", "")
    if url:
        return url
    incident_id = incident.get("incident_id", "unknown")
    return (
        f"https://console.cloud.google.com/monitoring/alerts/incidents/{incident_id}"
    )


def _format_timestamp(epoch: int | None) -> str:
    if epoch is None:
        return "unknown"
    try:
        dt = datetime.fromtimestamp(int(epoch), tz=timezone.utc)
        return dt.isoformat()
    except (ValueError, OSError):
        return str(epoch)


def normalise_alert(raw_message: dict[str, Any]) -> dict[str, Any]:
    """Decode a Pub/Sub message and normalise it into an issue payload.

    Input: a single Pub/Sub message dict (the ``message`` key of a pull
    response item or a push payload). Expected shape::

        {
          "data": "<base64-encoded JSON>",
          "messageId": "...",
          "publishTime": "..."
        }

    Returns a dict with ``title``, ``labels``, ``body``, and ``policy_id``.
    On any parse error the function returns a best-effort payload rather than
    raising — downstream idempotency checks will de-dup duplicates.
    """
    # Decode the base64 data field
    data_b64 = raw_message.get("data", "")
    try:
        alert_json = base64.b64decode(data_b64).decode("utf-8")
        alert: dict[str, Any] = json.loads(alert_json)
    except Exception as exc:  # noqa: BLE001
        log.warning("Failed to decode Pub/Sub message data: %s", exc)
        alert = {}

    incident: dict[str, Any] = alert.get("incident", {})
    condition_name: str = incident.get("condition_name", "") or alert.get(
        "condition_name", "Unknown condition"
    )
    policy_id = _extract_policy_id(incident)
    alert_url = _build_alert_url(incident)
    state = incident.get("state", "unknown")
    started_at = _format_timestamp(incident.get("started_at"))
    summary = incident.get("summary", condition_name)
    resource_type = incident.get("resource", {}).get("type", "")
    project_id = (
        incident.get("resource", {}).get("labels", {}).get("project_id", "")
        or incident.get("resource_name", "").replace("projects/", "")
    )

    # iOS-friendly title: prefix + condition name (short, scannable)
    title = f"[gcp-alert] {condition_name}"

    # One-paragraph summary for the issue body (iOS-friendly, above the fold)
    para = (
        f"GCP Cloud Monitoring alert: **{condition_name}**"
        f"{' on ' + resource_type if resource_type else ''}."
        f" Alert state: `{state}`."
        f" Started: `{started_at}`."
    )
    if summary and summary != condition_name:
        para += f" {summary}"

    # Full alert JSON in a collapsed <details> block
    full_json = json.dumps(alert, indent=2, default=str)

    body = (
        f"{para}\n"
        f"\n"
        f"## Source\n"
        f"\n"
        f"- Alert: {alert_url}\n"
        f"- Policy id: `{policy_id}`\n"
        f"- Project: `{project_id}`\n"
        f"- State: `{state}` | Started: `{started_at}`\n"
        f"\n"
        f"## Suggested Team: watchers\n"
        f"\n"
        f"<!-- gcp-policy: {policy_id} -->\n"
        f"\n"
        f"<details>\n"
        f"<summary>Full alert JSON</summary>\n"
        f"\n"
        f"```json\n"
        f"{full_json}\n"
        f"```\n"
        f"\n"
        f"</details>\n"
    )

    return {
        "title": title,
        "labels": ["watcher-auto"],
        "body": body,
        "policy_id": policy_id,
    }


# ---------------------------------------------------------------------------
# Idempotency check — skip if issue already exists for this policy
# ---------------------------------------------------------------------------


def _issue_exists_for_policy(policy_id: str, repo: str | None) -> bool:
    """Return True if an open issue with ``<!-- gcp-policy: <id> -->`` exists.

    Uses ``gh issue list`` with a search query; no external API calls.
    Returns False (allow creation) on any gh CLI error so a missing/
    misconfigured CLI does not silently drop alerts.
    """
    marker = f"gcp-policy: {policy_id}"
    cmd = [
        "gh", "issue", "list",
        "--state", "open",
        "--search", marker,
        "--json", "number,title",
        "--limit", "5",
    ]
    if repo:
        cmd += ["--repo", repo]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            log.warning(
                "gh issue list failed (rc=%d): %s",
                result.returncode,
                result.stderr.strip(),
            )
            return False
        issues = json.loads(result.stdout or "[]")
        return len(issues) > 0
    except Exception as exc:  # noqa: BLE001
        log.warning("Idempotency check failed: %s", exc)
        return False


# ---------------------------------------------------------------------------
# Issue creation
# ---------------------------------------------------------------------------


def _create_issue(
    payload: dict[str, Any],
    repo: str | None,
) -> str | None:
    """Create a GitHub issue via the ``gh`` CLI. Returns the issue URL or None."""
    cmd = [
        "gh", "issue", "create",
        "--title", payload["title"],
        "--body", payload["body"],
    ]
    for label in payload.get("labels", []):
        cmd += ["--label", label]
    if repo:
        cmd += ["--repo", repo]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            log.error(
                "gh issue create failed (rc=%d): %s",
                result.returncode,
                result.stderr.strip(),
            )
            return None
        url = result.stdout.strip()
        return url
    except Exception as exc:  # noqa: BLE001
        log.error("Issue creation failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Pub/Sub pull
# ---------------------------------------------------------------------------


def _pull_messages(
    subscription: str,
    project: str,
    max_messages: int,
    timeout: int,
) -> list[dict[str, Any]]:
    """Pull messages from a Pub/Sub subscription via the gcloud CLI.

    Returns a list of raw message dicts (the ``message`` field of each
    receivedMessage). Acknowledges each message after a successful pull so
    re-runs don't re-process the same alert (idempotency guard provides the
    second line of defence).
    """
    try:
        from google.cloud import pubsub_v1  # type: ignore[import-untyped]
    except ImportError:
        log.error(
            "google-cloud-pubsub is required; run `uv sync` inside "
            "plugin/ralph-hero/scripts/monitoring-bridge/"
        )
        return []

    subscriber = pubsub_v1.SubscriberClient()
    subscription_path = (
        subscription
        if subscription.startswith("projects/")
        else f"projects/{project}/subscriptions/{subscription}"
    )

    try:
        response = subscriber.pull(
            request={
                "subscription": subscription_path,
                "max_messages": max_messages,
            },
            timeout=float(timeout),
        )
    except Exception as exc:  # noqa: BLE001
        log.error("Pub/Sub pull failed: %s", exc)
        return []

    messages = []
    ack_ids = []
    for received_message in response.received_messages:
        msg = received_message.message
        raw = {
            "data": base64.b64encode(msg.data).decode("utf-8"),
            "messageId": msg.message_id,
            "publishTime": str(msg.publish_time),
        }
        messages.append(raw)
        ack_ids.append(received_message.ack_id)

    if ack_ids:
        try:
            subscriber.acknowledge(
                request={
                    "subscription": subscription_path,
                    "ack_ids": ack_ids,
                }
            )
            log.info("Acknowledged %d message(s)", len(ack_ids))
        except Exception as exc:  # noqa: BLE001
            log.warning("Acknowledge failed (messages will be re-delivered): %s", exc)

    subscriber.close()
    return messages


# ---------------------------------------------------------------------------
# Fixture-based dry-run
# ---------------------------------------------------------------------------


def _load_fixture(fixture_path: Path) -> list[dict[str, Any]]:
    """Load the sample-alert.json fixture as a single-item message list.

    The fixture stores the full Pub/Sub push payload shape; we extract
    the ``message`` sub-key. If the JSON has a ``_decoded`` key (the
    human-readable companion) we re-encode the raw incident as base64 so
    the normaliser's decode path runs normally.
    """
    with fixture_path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    msg = data.get("message", data)

    # If the fixture has a ``_decoded`` companion, re-encode it so we
    # exercise the base64 → JSON decode path in normalise_alert.
    if "_decoded" in data and "data" in msg:
        decoded = data["_decoded"]
        msg = dict(msg)  # shallow copy
        msg["data"] = base64.b64encode(
            json.dumps(decoded).encode("utf-8")
        ).decode("utf-8")

    return [msg]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="subscribe.py",
        description=(
            "Cloud Monitoring → GitHub Projects board bridge. "
            "Pulls Pub/Sub messages and creates watcher-auto-labeled "
            "issues on the GitHub Projects V2 board."
        ),
    )
    parser.add_argument(
        "--subscription",
        required=True,
        help=(
            "Pub/Sub subscription name or full resource path "
            "(projects/<proj>/subscriptions/<name>)."
        ),
    )
    parser.add_argument(
        "--project",
        required=True,
        help="GCP project id (used to resolve short subscription names).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Read from the fixture file instead of Pub/Sub and print "
            "the normalised issue payload to stdout. Does NOT create issues."
        ),
    )
    parser.add_argument(
        "--max-messages",
        type=int,
        default=10,
        help="Maximum number of messages to pull per run (default: 10).",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=30,
        help="Pull timeout in seconds (default: 30).",
    )
    parser.add_argument(
        "--repo",
        default=None,
        help=(
            "GitHub repo in owner/name format. Defaults to the current "
            "repo inferred by gh CLI from git context."
        ),
    )
    parser.add_argument(
        "--fixture",
        default=None,
        help=(
            "Path to the fixture JSON file for dry-run mode. "
            "Defaults to fixtures/sample-alert.json next to this script."
        ),
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        help="Logging level (default: INFO).",
    )

    args = parser.parse_args(argv)

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if args.dry_run:
        fixture_path = (
            Path(args.fixture)
            if args.fixture
            else Path(__file__).resolve().parent / "fixtures" / "sample-alert.json"
        )
        if not fixture_path.exists():
            log.error("Fixture file not found: %s", fixture_path)
            return 1
        messages = _load_fixture(fixture_path)
        log.info("Dry-run mode: loaded %d message(s) from fixture", len(messages))
    else:
        messages = _pull_messages(
            args.subscription,
            args.project,
            args.max_messages,
            args.timeout,
        )
        log.info("Pulled %d message(s) from Pub/Sub", len(messages))

    if not messages:
        print("No messages to process.")
        return 0

    created = 0
    skipped = 0
    failed = 0

    for i, msg in enumerate(messages, start=1):
        payload = normalise_alert(msg)
        policy_id = payload["policy_id"]

        if args.dry_run:
            print(f"\n--- Message {i} ---")
            print(f"title: {payload['title']}")
            print(f"labels: {payload['labels']}")
            print(f"policy_id: {policy_id}")
            print("body:")
            print(payload["body"])
            created += 1
            continue

        # Idempotency check
        if _issue_exists_for_policy(policy_id, args.repo):
            log.info(
                "Skipping policy_id=%s — open issue already exists", policy_id
            )
            skipped += 1
            continue

        url = _create_issue(payload, args.repo)
        if url:
            print(f"Created issue: {url}  [policy_id={policy_id}]")
            created += 1
        else:
            log.error("Failed to create issue for policy_id=%s", policy_id)
            failed += 1

    print(
        f"\nResult: {created} created, {skipped} skipped (duplicate), "
        f"{failed} failed."
    )
    return 1 if failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
