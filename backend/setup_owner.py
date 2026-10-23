"""Explicit, idempotent owner bootstrap. Does not create or guess an administrator."""
from dotenv import load_dotenv
from fastapi import HTTPException
from backend.approvals import owner_id, rpc


def main():
    load_dotenv()
    try:
        owner = owner_id()
        rpc("initialize_approval_owner", {"p_owner": owner})
    except HTTPException as exc:
        raise SystemExit(exc.detail) from None
    print("Designated verified owner explicitly approved. Approval enforcement is ready.")


if __name__ == "__main__":
    main()
