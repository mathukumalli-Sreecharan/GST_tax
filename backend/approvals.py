"""Approval authorization and owner-only HTTP API. No client-supplied identity is trusted."""
from __future__ import annotations

import json
import os
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, ConfigDict

from backend.auth import require_authenticated_user

router = APIRouter(prefix="/api", tags=["approvals"])
Status = Literal["pending", "approved", "rejected", "revoked"]

# Only these review database messages are safe and useful to return to the
# review UI. All other Postgres details remain hidden.
_REVIEW_DB_ERRORS = {
    ("40001", "Review changed"): (409, "This review changed while the request was being processed. Reload it to get the latest saved decisions."),
    ("40001", "Unsafe review transition"): (409, "The review is in a state that does not allow this operation. Reload it and check its status."),
    ("40001", "Invalid review mutation"): (409, "The review update was rejected as invalid. Reload the review and retry."),
    ("40001", "Generation snapshot is immutable"): (409, "The saved review decisions changed during generation. Reload the review before retrying."),
    ("40001", "Review upload state changed"): (409, "The review upload state changed. Reload the review."),
    ("40001", "Generation lease expired or artifact is not fenced"): (409, "The generation lease expired or changed. Reload the review and check its status."),
    ("40001", "Artifact sizes are required"): (409, "The generated artifact could not be committed because its size metadata is missing."),
    ("40001", "Artifact sizes exceed limits"): (413, "The generated workbook or report exceeds the 50 MiB per-file limit."),
    ("40001", "Committed artifacts are immutable"): (409, "The saved export is immutable. Reload the review to get its current status."),
    ("40001", "Previous generation attempt is awaiting artifact reconciliation"): (409, "A previous generation attempt is being safely reconciled. Retry generation shortly."),
    ("40001", "Pending generation token is immutable"): (409, "A previous generation attempt is being safely reconciled. Retry generation shortly."),
    ("P0001", "Review quota reached"): (429, "This account has reached the five active review-session limit. Wait for a session to expire or remove one from the review list."),
    ("P0001", "Review storage quota reached"): (507, "Private review storage is full. No saved review decisions were replaced."),
    ("P0001", "Generation token reused or attempt limit reached"): (409, "This review has reached its generation-attempt limit. Reload it and check its status."),
    ("P0001", "Review artifact quota reached"): (507, "Private storage cannot reserve space for this generated workbook. No saved review decisions were replaced."),
    ("P0001", "Review metadata quota reached"): (507, "Private review storage is full. The saved decisions could not be committed."),
}


def owner_id() -> str:
    try:
        return str(UUID(os.environ["ADMIN_USER_ID"].strip()))
    except (KeyError, ValueError):
        raise HTTPException(503, "Approval administration is not configured.") from None


def rpc(name: str, payload: dict):
    """Backend-only RPCs; never expose the service key or database error bodies."""
    url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise HTTPException(503, "Approval service is not configured.")
    headers = {"apikey": key, "Content-Type": "application/json"}
    # New Supabase secret keys use apikey; legacy service-role JWTs also use Bearer.
    if not key.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {key}"
    request = Request(f"{url}/rest/v1/rpc/{name}", json.dumps(payload).encode(), headers, method="POST")
    try:
        with urlopen(request, timeout=10) as result:
            content = result.read()
            return json.loads(content) if content else None
    except HTTPError as exc:
        try:
            error = json.loads(exc.read())
            code = error.get("code")
            database_message = error.get("message")
        except (ValueError, AttributeError):
            code = None
            database_message = None
        if name.startswith("review_") and isinstance(database_message, str):
            mapped = _REVIEW_DB_ERRORS.get((code, database_message))
            if mapped:
                status, detail = mapped
                raise HTTPException(status, detail) from None
        if code == "42501":
            raise HTTPException(403, "Owner access required.") from None
        if code == "40001":
            raise HTTPException(409, "Approval changed. Refresh and try again.") from None
        if code == "P0002":
            raise HTTPException(404, "Applicant not found.") from None
        if code == "P0001":
            raise HTTPException(409, "This approval action is not allowed. Verify the email and refresh the applicant status.") from None
        if code in {"PGRST202", "42P01", "42883"}:
            raise HTTPException(503, "A required database migration is missing or its functions are not in the API schema cache. Apply the Supabase migrations in order through the latest migration, then retry.") from None
        if exc.code == 401:
            raise HTTPException(503, "Supabase rejected the backend credentials. Check the project URL and server-only service-role or secret key.") from None
        raise HTTPException(503, "Approval database is unavailable or setup is incomplete.") from None
    except (URLError, OSError, ValueError):
        raise HTTPException(503, "Approval service is temporarily unavailable.") from None


def approval_state(user_id: str) -> dict:
    state = rpc("approval_context", {"p_user": user_id, "p_owner": owner_id()})
    if not isinstance(state, dict) or state.get("ready") is not True:
        raise HTTPException(503, "Approval setup is incomplete. The owner must be explicitly approved before access is enabled.")
    return state


def require_approved_user(user_id: str = Depends(require_authenticated_user)) -> str:
    state = approval_state(user_id)
    if state.get("email_verified") is not True:
        raise HTTPException(403, "Verify your email before using GST Ledger Studio.")
    if state.get("status") != "approved":
        messages = {"pending": "Your account is awaiting administrator approval.",
                    "rejected": "Your account approval request was rejected.",
                    "revoked": "Your account access has been revoked."}
        raise HTTPException(403, messages.get(state.get("status"), "Account approval is required."))
    return user_id


def require_admin(user_id: str = Depends(require_authenticated_user)) -> str:
    # Compare verified JWT identity with the backend environment before any privileged call.
    if user_id != owner_id():
        raise HTTPException(403, "Owner access required.")
    state = approval_state(user_id)
    if not (state.get("is_admin") is True and state.get("status") == "approved" and state.get("email_verified") is True):
        raise HTTPException(403, "Owner access required.")
    return user_id


@router.get("/account/approval")
def account_approval(response: Response, user_id: str = Depends(require_authenticated_user)):
    response.headers["Cache-Control"] = "private, no-store"
    return approval_state(user_id)


@router.get("/admin/approvals")
def list_approvals(response: Response, status: Status | None = None,
                   offset: int = Query(0, ge=0, le=1000000), actor: str = Depends(require_admin)):
    response.headers["Cache-Control"] = "private, no-store"
    return rpc("admin_approval_list", {"p_actor": actor, "p_owner": owner_id(), "p_status": status, "p_offset": offset})


@router.get("/admin/approvals/{user_id}")
def applicant_detail(user_id: UUID, actor: str = Depends(require_admin)):
    return rpc("admin_approval_applicant", {"p_actor": actor, "p_owner": owner_id(), "p_user": str(user_id)})


class Decision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["approved", "rejected", "revoked"]
    expected_status: Status


@router.post("/admin/approvals/{user_id}")
def decide_approval(user_id: UUID, decision: Decision, actor: str = Depends(require_admin)):
    if str(user_id) == owner_id():
        raise HTTPException(409, "The owner's approval cannot be changed here.")
    return rpc("change_approval", {"p_actor": actor, "p_owner": owner_id(), "p_user": str(user_id),
                                  "p_status": decision.status, "p_expected": decision.expected_status})
