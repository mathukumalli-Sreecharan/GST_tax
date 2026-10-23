"""Private persistent file history. Every user operation requires current approval."""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Literal
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from backend.approvals import require_approved_user, rpc

router = APIRouter(prefix="/api/files", tags=["My Files"])
BUCKET = "generated-excel-files"
MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
MAX_OUTPUT_BYTES = 50 * 1024 * 1024
logger = logging.getLogger(__name__)


def storage_request(method: str, path: str, body: bytes | None = None, *, content_type=MIME) -> bytes:
    url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise HTTPException(503, "Private file storage is not configured.")
    headers = {"apikey": key, "Content-Type": content_type, "x-upsert": "false"}
    if not key.startswith("sb_secret_"):
        headers["Authorization"] = "Bearer " + key
    request = Request(f"{url}/storage/v1/{path}", body, headers, method=method)
    try:
        with urlopen(request, timeout=30) as result:
            content = result.read(MAX_OUTPUT_BYTES + 1)
            if len(content) > MAX_OUTPUT_BYTES:
                raise HTTPException(503, "Stored workbook exceeds the supported download size.")
            return content
    except HTTPError as exc:
        # Object deletion is idempotent, including an upload that never reached Storage.
        if method == "DELETE" and exc.code == 404:
            return b""
        raise HTTPException(503, "Private file storage is temporarily unavailable. Please retry.") from None
    except (URLError, OSError):
        raise HTTPException(503, "Private file storage is temporarily unavailable. Please retry.") from None


def object_path(item: dict) -> str:
    expected = f"{UUID(item['user_id'])}/{UUID(item['id'])}.xlsx"
    if item.get("storage_path") != expected:
        raise HTTPException(503, "Stored file metadata could not be validated.")
    return expected


def remove_object(item: dict):
    path = object_path(item)
    storage_request("DELETE", f"object/{BUCKET}", json.dumps({"prefixes": [path]}).encode(), content_type="application/json")
    rpc("finish_generated_file_delete", {"p_id": item["id"], "p_token": item["cleanup_token"]})


def save_generated_file(file_id: str, user_id: str, original_name: str, output: Path, summary: dict, warnings: int, *, output_name: str | None = None) -> dict:
    """Reserve metadata before upload so cleanup can find partial/ambiguous uploads."""
    identity = str(UUID(file_id))
    if output.stat().st_size > MAX_OUTPUT_BYTES:
        return {"saved": False, "warning": "The workbook exceeds the 50 MB history limit. Use the current-session download."}
    try:
        item = rpc("reserve_generated_file", {"p_id": identity, "p_user": user_id,
            "p_original": original_name, "p_output": output_name or "updated_" + original_name,
            "p_size": output.stat().st_size, "p_summary": summary, "p_warnings": warnings})
        storage_request("POST", f"object/{BUCKET}/{object_path(item)}", output.read_bytes())
        saved = rpc("complete_generated_file", {"p_id": identity, "p_user": user_id})
        return {"saved": True, "id": identity, "expires_at": saved["expires_at"]}
    except Exception:
        # Do not erase the reservation: scheduled cleanup must retain knowledge of
        # the path if Storage succeeded but finalization or its response was lost.
        try:
            rpc("abandon_generated_file", {"p_id": identity, "p_user": user_id})
        except Exception:
            pass  # Durable uploading/deleting reservation remains for the cron job.
        logger.warning("Permanent file save unavailable; session download retained.")
        return {"saved": False, "warning": "Permanent save to My Files could not be confirmed. Your current-session download is available for up to one hour. Download it before leaving this session."}


def get_file(file_id: str, user_id: str) -> dict:
    try:
        identity = str(UUID(file_id))
    except ValueError:
        raise HTTPException(404, "This file is not available.") from None
    return rpc("get_generated_file", {"p_id": identity, "p_user": user_id})


def file_download(file_id: str, user_id: str) -> Response:
    item = get_file(file_id, user_id)
    content = storage_request("GET", f"object/authenticated/{BUCKET}/{object_path(item)}")
    return Response(content, media_type=MIME, headers={
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(item["output_filename"], safe=""),
        "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.get("")
def list_files(response: Response, search: str = Query("", max_length=200),
               sort: Literal["newest", "oldest", "name", "size"] = "newest",
               offset: int = Query(0, ge=0, le=1000000), user_id: str = Depends(require_approved_user)):
    response.headers["Cache-Control"] = "private, no-store"
    return rpc("list_generated_files", {"p_user": user_id, "p_search": search, "p_sort": sort, "p_offset": offset})


@router.get("/{file_id}/download")
def download_file(file_id: UUID, user_id: str = Depends(require_approved_user)):
    return file_download(str(file_id), user_id)


@router.delete("/{file_id}")
def delete_file(file_id: UUID, response: Response, user_id: str = Depends(require_approved_user)):
    item = rpc("mark_generated_file_deleted", {"p_id": str(file_id), "p_user": user_id})
    try:
        remove_object(item)
        return {"deleted": True, "queued": False}
    except Exception:
        # Immediately hidden and undownloadable; retry the object removal on schedule.
        response.status_code = 202
        return {"deleted": False, "queued": True,
                "message": "File access removed. Storage deletion is queued for retry."}
