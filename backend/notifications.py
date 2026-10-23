"""Durable outbox delivery: database leases plus stable Resend idempotency keys."""
import json
import logging
import os
import re
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit

from backend.approvals import rpc

logger = logging.getLogger(__name__)


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
                 "Idempotency-Key": "gst-approval/" + item["id"]}, method="POST")
            with urlopen(request, timeout=15) as result:
                provider_id = json.loads(result.read())["id"]
                if not isinstance(provider_id, str) or not provider_id:
                    raise ValueError("Missing provider ID")
        except HTTPError as exc:
            error = ("Resend HTTP 403: verify ADMIN_NOTIFICATION_EMAIL is the Resend account owner Gmail, and check sender and API key permissions."
                     if exc.code == 403 and "onboarding@resend.dev" in sender.lower()
                     else f"Email provider HTTP {exc.code}")  # Never store credentials/provider response bodies.
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
    print(f"Delivered {deliver_notifications(limit=50)} notification(s).")


if __name__ == "__main__":
    main()
