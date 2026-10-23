"""Supabase Auth token validation for protected FastAPI endpoints."""
from __future__ import annotations

import json
import os
import time
from functools import lru_cache
from uuid import UUID
import jwt
from jwt import PyJWKClient
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_bearer = HTTPBearer(auto_error=False)


@lru_cache(maxsize=4)
def jwks_client(url: str) -> PyJWKClient:
    return PyJWKClient(f"{url}/auth/v1/.well-known/jwks.json", lifespan=300, timeout=8)


def require_authenticated_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str:
    """Validate a Supabase access token with Auth and return the trusted user ID.

    Verify asymmetric tokens with JWKS; validate legacy HS256 via Supabase Auth.
    Authorization always requires a verified identity and application claims.
    """
    if credentials is None or credentials.scheme.lower() != "bearer" or not credentials.credentials:
        raise HTTPException(401, "Authentication required.", headers={"WWW-Authenticate": "Bearer"})

    supabase_url = os.getenv("SUPABASE_URL", "").strip().rstrip("/")
    publishable_key = os.getenv("SUPABASE_PUBLISHABLE_KEY", "").strip()
    if not supabase_url or not publishable_key:
        raise HTTPException(503, "Authentication is not configured on this service.")

    token = credentials.credentials
    unauthorized = HTTPException(401, "Invalid or expired session.", headers={"WWW-Authenticate": "Bearer"})
    try:
        algorithm = jwt.get_unverified_header(token).get("alg")
        # Only use the untrusted header to choose a verifier, never as authorization.
        if algorithm in ("RS256", "ES256"):
            key = jwks_client(supabase_url).get_signing_key_from_jwt(token)
            claims = jwt.decode(token, key.key, algorithms=[algorithm],
                                audience="authenticated", issuer=f"{supabase_url}/auth/v1",
                                options={"require": ["exp", "iat", "sub", "iss", "aud"]})
            if claims.get("role") != "authenticated":
                raise unauthorized
            return str(UUID(claims["sub"]))
        if algorithm != "HS256":
            raise unauthorized
    except jwt.PyJWKClientConnectionError:
        raise HTTPException(503, "Authentication service is temporarily unavailable.") from None
    except (jwt.PyJWTError, ValueError, TypeError, KeyError):
        raise unauthorized from None

    request = Request(
        f"{supabase_url}/auth/v1/user",
        headers={
            "apikey": publishable_key,
            "Authorization": f"Bearer {credentials.credentials}",
            "Accept": "application/json",
        },
        method="GET",
    )
    try:
        with urlopen(request, timeout=8) as response:
            if response.status != 200:
                raise HTTPException(401, "Invalid or expired session.", headers={"WWW-Authenticate": "Bearer"})
            user = json.loads(response.read())
    except HTTPError as exc:
        if 400 <= exc.code < 500:
            raise HTTPException(401, "Invalid or expired session.", headers={"WWW-Authenticate": "Bearer"}) from None
        raise HTTPException(503, "Authentication service is temporarily unavailable.") from None
    except (URLError, TimeoutError, OSError):
        raise HTTPException(503, "Authentication service is temporarily unavailable.") from None
    except (json.JSONDecodeError, UnicodeDecodeError, TypeError):
        raise HTTPException(401, "Invalid authentication response.", headers={"WWW-Authenticate": "Bearer"}) from None

    user_id = user.get("id") if isinstance(user, dict) else None
    if not isinstance(user_id, str) or not user_id:
        raise HTTPException(401, "Invalid authentication response.", headers={"WWW-Authenticate": "Bearer"})
    # The Auth server has verified the signature. Also enforce this app's claims.
    try:
        claims = jwt.decode(token, options={"verify_signature": False})
        if (claims.get("iss") != f"{supabase_url}/auth/v1"
                or claims.get("aud") != "authenticated"
                or claims.get("role") != "authenticated"
                or claims.get("sub") != user_id
                or not isinstance(claims.get("exp"), (int, float))
                or claims["exp"] <= time.time()):
            raise unauthorized
        return str(UUID(user_id))
    except (jwt.PyJWTError, ValueError, TypeError):
        raise unauthorized from None
