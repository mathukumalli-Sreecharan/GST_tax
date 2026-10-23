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
            code = json.loads(exc.read()).get("code")
        except (ValueError, AttributeError):
            code = None
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
