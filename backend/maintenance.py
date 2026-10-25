"""Durable scheduled cleanup; run via Render cron, independently of web uptime."""
import logging
from backend.approvals import rpc
from backend.files import remove_object
from backend.notifications import deliver_notifications

logger = logging.getLogger(__name__)


def cleanup_expired_files(max_batches=20):
    removed = failures = 0
    for _ in range(max_batches):
        items = rpc("claim_expired_generated_files", {})
        if not items:
            break
        for item in items:
            try:
                remove_object(item)
                removed += 1
            except Exception:
                failures += 1
                logger.warning("Private file cleanup deferred; durable deletion will retry.")
    return {"removed": removed, "deferred": failures}


def main():
    from dotenv import load_dotenv
    from backend.security import validate_production_config
    load_dotenv()
    validate_production_config()
    result = cleanup_expired_files()
    from backend.review_store import durable, cleanup_reviews
    if durable():cleanup_reviews()
    sent = deliver_notifications(limit=50)
    print(f"Maintenance: {result['removed']} files removed, {result['deferred']} deferred; {sent} emails accepted.")
    if result["deferred"]:
        raise SystemExit(1)  # Scheduler monitoring can alert; leases expire automatically.


if __name__ == "__main__":
    main()
