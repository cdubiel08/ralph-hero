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
  ``## Suggested Team: watchers`` (or ``caretakers`` for CRITICAL-severity
  alerts), full alert JSON in ``<details>``.

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

    Returns a dict with ``title``, ``labels``, ``body``, ``policy_id``, and
    ``severity``. On any parse error the function returns a best-effort payload
    rather than raising — downstream idempotency checks will de-dup duplicates.
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
    # Severity field from the Cloud Monitoring incident payload.
    # Missing or non-string values are normalised to "" — never default to
    # "CRITICAL" so the gate below is always a strict opt-in.
    severity: str = incident.get("severity", "") or ""

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

    # Severity-aware team routing: CRITICAL alerts go directly to caretakers,
    # all other severities (WARNING, ERROR, or missing) go to watchers.
    suggested_team = "caretakers" if severity == "CRITICAL" else "watchers"

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
        f"**Policy ID:** `gcp-policy/{policy_id}`\n"
        f"\n"
        f"## Suggested Team: {suggested_team}\n"
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
        "severity": severity,
    }


# ---------------------------------------------------------------------------
# Idempotency check — skip if issue already exists for this policy
# ---------------------------------------------------------------------------


def _issue_exists_for_policy(policy_id: str, repo: str | None) -> bool:
    """Return True if an open issue with the plain-text policy marker exists.

    Searches for the plain-text line ``gcp-policy/<id>`` which is indexed by
    GitHub's search API (HTML comments are stripped before indexing and would
    always return zero matches).

    Uses ``gh issue list`` with a search query; no external API calls.
    Returns False (allow creation) on any gh CLI error so a missing/
    misconfigured CLI does not silently drop alerts.
    """
    marker = f"gcp-policy/{policy_id}"
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
# RemoteTrigger producer — fires a cloud Routine for CRITICAL-severity alerts
# ---------------------------------------------------------------------------


def _fire_routine(issue_number: int, team: str, *, dry_run: bool) -> bool:
    """Fire the ``ralph-hero-critical-alert`` cloud Routine via ``gh routine fire``.

    In dry-run mode, prints ``[would-fire-routine] issue=<N> team=<team>`` to
    stdout and returns True without invoking ``subprocess``.

    In live mode, invokes ``gh routine fire ralph-hero-critical-alert`` with the
    ``{issue_number, team}`` payload. On success logs at INFO and returns True.
    On any failure (non-zero returncode, timeout, unexpected exception) logs at
    WARNING (not ERROR — the GitHub Issue was already created, so the worst case
    is "autopilot picks it up on the next tick") and returns False. The relay
    does not retry on failure.

    Args:
        issue_number: GitHub issue number extracted from the freshly-created
            issue URL. Use ``0`` as a placeholder in dry-run mode (the
            ``[would-fire-routine]`` output line renders ``issue=0``). Callers
            MAY also use ``0`` as a "do not fire" sentinel in live mode: the
            ``if issue_number:`` guard at the call site treats ``0`` as falsy
            and skips the live ``gh routine fire`` invocation entirely. This
            pattern is used when URL parsing fails and the real issue number
            cannot be determined.
        team: The Director team to dispatch (e.g. ``"caretakers"``).
        dry_run: If True, print the would-fire marker and return without
            executing ``gh``.

    Returns:
        True on success (or dry-run), False on any live-mode failure.
    """
    if dry_run:
        print(f"[would-fire-routine] issue={issue_number} team={team}")
        return True

    json_payload = json.dumps({"issue_number": issue_number, "team": team})
    cmd = [
        "gh", "routine", "fire", "ralph-hero-critical-alert",
        "--data", json_payload,
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            log.info(
                "Fired Routine ralph-hero-critical-alert for issue #%d",
                issue_number,
            )
            return True
        log.warning(
            "gh routine fire failed (rc=%d): %s",
            result.returncode,
            result.stderr.strip(),
        )
        return False
    except subprocess.TimeoutExpired:
        log.warning(
            "gh routine fire timed out for issue #%d — "
            "autopilot will pick up the issue on the next tick",
            issue_number,
        )
        return False
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "gh routine fire raised an unexpected error for issue #%d: %s",
            issue_number,
            exc,
        )
        return False


# ---------------------------------------------------------------------------
# Pub/Sub pull
# ---------------------------------------------------------------------------


def _pull_messages(
    subscription: str,
    project: str,
    max_messages: int,
    timeout: int,
) -> tuple[list[dict[str, Any]], list[str], "pubsub_v1.SubscriberClient", str]:
    """Pull messages from a Pub/Sub subscription via the Pub/Sub client library.

    Returns a 4-tuple of:
    - list of raw message dicts (the ``message`` field of each receivedMessage)
    - list of ack_ids in the same order as the messages
    - the open SubscriberClient (caller must close it)
    - the resolved subscription path

    The caller is responsible for ACKing each message individually AFTER
    successfully processing it (at-least-once delivery). Messages that fail
    processing are NOT ACKed and will be re-delivered by Pub/Sub after the
    ack deadline expires.

    Returns an empty tuple-of-empties on error so the caller can do a simple
    ``if not messages`` guard.
    """
    try:
        from google.cloud import pubsub_v1  # type: ignore[import-untyped]
    except ImportError:
        log.error(
            "google-cloud-pubsub is required; run `uv sync` inside "
            "plugin/ralph-hero/scripts/monitoring-bridge/"
        )
        return [], [], None, ""  # type: ignore[return-value]

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
        subscriber.close()
        return [], [], None, ""  # type: ignore[return-value]

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

    return messages, ack_ids, subscriber, subscription_path


def _ack_message(
    subscriber: "pubsub_v1.SubscriberClient",
    subscription_path: str,
    ack_id: str,
) -> None:
    """ACK a single Pub/Sub message. Logs a warning on failure (non-fatal)."""
    try:
        subscriber.acknowledge(
            request={
                "subscription": subscription_path,
                "ack_ids": [ack_id],
            }
        )
        log.debug("Acknowledged message ack_id=%s…", ack_id[:16])
    except Exception as exc:  # noqa: BLE001
        log.warning(
            "Acknowledge failed for ack_id=%s… (will be re-delivered): %s",
            ack_id[:16],
            exc,
        )


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
        ack_ids: list[str] = []
        subscriber = None
        subscription_path = ""
        log.info("Dry-run mode: loaded %d message(s) from fixture", len(messages))
    else:
        messages, ack_ids, subscriber, subscription_path = _pull_messages(
            args.subscription,
            args.project,
            args.max_messages,
            args.timeout,
        )
        log.info("Pulled %d message(s) from Pub/Sub", len(messages))

    if not messages:
        print("No messages to process.")
        if subscriber is not None:
            subscriber.close()
        return 0

    created = 0
    skipped = 0
    failed = 0

    try:
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
                # Gate: would the Routine fire for this message?
                if payload.get("severity") == "CRITICAL":
                    _fire_routine(0, "caretakers", dry_run=True)
                created += 1
                continue

            # Idempotency check — duplicate alerts are ACKed (already handled)
            if _issue_exists_for_policy(policy_id, args.repo):
                log.info(
                    "Skipping policy_id=%s — open issue already exists", policy_id
                )
                skipped += 1
                # ACK the duplicate so it isn't re-delivered on the next run
                _ack_message(subscriber, subscription_path, ack_ids[i - 1])
                continue

            url = _create_issue(payload, args.repo)
            if url:
                print(f"Created issue: {url}  [policy_id={policy_id}]")
                created += 1
                # ACK only after successful issue creation (at-least-once delivery)
                _ack_message(subscriber, subscription_path, ack_ids[i - 1])
                # RemoteTrigger gate: fire the cloud Routine for CRITICAL alerts.
                # Failure is non-fatal — the issue is already created and autopilot
                # will pick it up on the next tick. The created/failed counters are
                # NOT adjusted on Routine failure.
                if payload.get("severity") == "CRITICAL":
                    try:
                        issue_number = int(url.rstrip("/").split("/")[-1])
                    except (ValueError, IndexError):
                        log.error(
                            "Could not parse issue number from URL %r; "
                            "skipping Routine fire (routine_fire_skipped_parse_failure)",
                            url,
                        )
                        issue_number = 0
                        failed += 1
                    if issue_number:
                        _fire_routine(issue_number, "caretakers", dry_run=False)
            else:
                log.error("Failed to create issue for policy_id=%s", policy_id)
                failed += 1
                # Do NOT ACK — Pub/Sub will re-deliver after the ack deadline
    finally:
        if subscriber is not None:
            subscriber.close()

    print(
        f"\nResult: {created} created, {skipped} skipped (duplicate), "
        f"{failed} failed."
    )
    return 1 if failed > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
