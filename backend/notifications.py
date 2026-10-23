"""Durable outbox delivery: database leases plus stable Resend idempotency keys."""
import json
import hashlib
import hmac
import logging
import os
import re
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

from backend.approvals import rpc

logger = logging.getLogger(__name__)


USER_AGENT = "GST-Ledger-Studio/1.0"


def runtime_diagnostics():
    """Offline configuration check. No raw key, headers or applicant data."""
    raw = os.getenv("RESEND_API_KEY", "")
    key = raw.strip()
    digest = hashlib.sha256(key.encode()).hexdigest() if key else None
    expected = os.getenv("RESEND_EXPECTED_KEY_SHA256", "").strip().lower()
    return {
        "key_present": bool(key),
        "key_format_valid": bool(re.fullmatch(r"re_[A-Za-z0-9_-]+", key)),
        "key_whitespace_trimmed": raw != key,
        "key_fingerprint": digest[:12] if digest else None,
        "expected_key_matches": hmac.compare_digest(digest or "", expected) if expected else None,
        "user_agent": USER_AGENT,
    }


def http_error_diagnostics(exc):
    """Classify bounded, untrusted error data; never emit arbitrary body text.

    Messages are canonical summaries, not redacted copies: provider errors may
    echo applicant names, email bodies, credentials or URLs in arbitrary fields.
    """
    try:
        body = exc.read(8192).decode("utf-8", errors="replace")
    except (OSError, ValueError):
        body = ""
    try:
        data = json.loads(body)
    except ValueError:
        data = None
    code, message = "unrecognized", "Unrecognized response; raw body withheld"
    if isinstance(data, dict):
        known = {
            "validation_error": "Provider rejected request validation",
            "restricted_api_key": "API key lacks permission for this operation",
            "invalid_api_key": "Provider rejected API key",
            "missing_api_key": "Provider did not receive API key",
            "rate_limit_exceeded": "Provider rate limit exceeded",
            "application_error": "Provider application error",
        }
        candidate = data.get("name") or data.get("code")
        if isinstance(candidate, str) and candidate in known:
            code, message = candidate, known[candidate]
        provider_message = data.get("message")
        if isinstance(provider_message, str):
            if "only send testing emails" in provider_message.lower():
                code, message = "test_sender_restriction", "Test sender recipient is not authorized"
            elif "domain is not verified" in provider_message.lower():
                code, message = "unverified_domain", "Sending domain is not verified"
    elif re.search(r"(?:error code[: ]*|error\s*)1010\b", body, re.I):
        code, message = "edge_1010", "Edge rejected client signature before API processing"
    headers = exc.headers or {}
    content_type = headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
    server = headers.get("Server", "").strip().lower()
    ray = headers.get("CF-Ray", "")
    retry = headers.get("Retry-After", "")
    return {
        "status": exc.code, "code": code, "message": message,
        "content_type": content_type if content_type in {"application/json", "text/html", "text/plain"} else "other",
        "server": server if server in {"cloudflare", "nginx", "envoy"} else "other",
        "cf_ray": ray if re.fullmatch(r"[0-9a-f]{16,32}(?:-[A-Z]{3})?", ray) else None,
        "retry_after_seconds": int(retry) if re.fullmatch(r"[0-9]{1,6}", retry) else None,
    }


def deliver_notifications(limit=5):
    key = os.getenv("RESEND_API_KEY", "").strip()
    sender = os.getenv("EMAIL_FROM", "").strip()
    recipient = os.getenv("ADMIN_NOTIFICATION_EMAIL", "").strip()
    origin = os.getenv("APP_BASE_URL", "").strip().rstrip("/")
    parsed = urlsplit(origin)
    if not all((key, sender, recipient, origin)):
        return 0  # Requests remain persisted even when email has not been configured.
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        logger.error("APP_BASE_URL must be a frontend origin")
        return 0
    if not re.fullmatch(r"[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@gmail\.com", recipient):
        logger.error("ADMIN_NOTIFICATION_EMAIL must be the authorized single Gmail address")
        return 0
    if os.getenv("RESEND_DIAGNOSTICS") == "1":
        logger.warning("Resend runtime diagnostics: %s", json.dumps(runtime_diagnostics(), sort_keys=True))
    delivered = 0
    for _ in range(limit):
        item = rpc("claim_approval_notification", {"p_admin_email": recipient, "p_sender": sender,
                                                  "p_admin_url": origin + "/admin/approvals"})
        if not item:
            break
        error, provider_id = None, None
        try:
            payload = item["payload"]
            # Never rewrite a frozen payload: Resend requires identical retries.
            # This also protects deployments that have not applied migration 005 yet.
            if (item.get("kind") != "request" or not isinstance(payload, dict)
                    or payload.get("to") != [recipient]
                    or payload.get("from") != sender
                    or set(payload) != {"from", "to", "subject", "text"}):
                raise ValueError("Unsafe frozen notification payload")
            request = Request("https://api.resend.com/emails", json.dumps(item["payload"]).encode(),
                {"Authorization": "Bearer " + key, "Content-Type": "application/json",
                 "User-Agent": USER_AGENT, "Accept": "application/json",
                 "Idempotency-Key": "gst-approval/" + item["id"]}, method="POST")
            with urlopen(request, timeout=15) as result:
                provider_id = json.loads(result.read())["id"]
                if not isinstance(provider_id, str) or not provider_id:
                    raise ValueError("Missing provider ID")
        except HTTPError as exc:
            diagnostic = http_error_diagnostics(exc)
            error = f"Resend HTTP {exc.code}: {diagnostic['code']}; {diagnostic['message']}"
            if os.getenv("RESEND_DIAGNOSTICS") == "1":
                logger.warning("Resend HTTP diagnostics: %s", json.dumps(diagnostic, sort_keys=True))
        except ValueError as exc:
            error = ("Notification blocked: frozen payload must be a request to the configured administrator with the configured sender; review without resetting."
                     if str(exc) == "Unsafe frozen notification payload"
                     else "Email delivery not confirmed; retry with the same idempotency key.")
        except (URLError, OSError, KeyError, TypeError):
            error = "Email delivery not confirmed; retry with the same idempotency key."
        rpc("finish_approval_notification", {"p_id": item["id"], "p_lease": item["lease_token"],
                                            "p_provider_id": provider_id, "p_error": error})
        if error is None:
            delivered += 1
    return delivered


def main():
    """Optional external scheduler: python -m backend.notifications (with env loaded)."""
    from dotenv import load_dotenv
    load_dotenv()
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-config", action="store_true", help="Offline key comparison; no RPC or email")
    args = parser.parse_args()
    if args.check_config:
        print(json.dumps(runtime_diagnostics(), sort_keys=True))
        return
    print(f"Delivered {deliver_notifications(limit=50)} notification(s).")


if __name__ == "__main__":
    main()
