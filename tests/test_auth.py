from review_helpers import reviewed_post
import time
from io import BytesIO
from unittest.mock import patch
from uuid import uuid4

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from fastapi.testclient import TestClient

from backend.auth import require_authenticated_user
from backend.approvals import require_approved_user
from backend.main import app

@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_PUBLISHABLE_KEY", "public-key")

@pytest.mark.parametrize("path", ["/api/excel/inspect", "/api/excel/process", "/api/excel/download/id", "/api/excel/report/id"])
def test_missing_credentials(path):
    client = TestClient(app)
    response = client.post(path) if path.endswith(("inspect", "process")) else client.get(path)
    assert response.status_code == 401

@pytest.mark.parametrize("token", ["invalid", "e30.e30.invalid", jwt.encode({"sub":"attacker"}, "x" * 64, algorithm="HS384")])
def test_invalid_jwt(configured, token):
    response = TestClient(app).get("/api/excel/download/id", headers={"Authorization": "Bearer " + token})
    assert response.status_code == 401

@pytest.mark.parametrize("mutation", [{}, {"exp":1}, {"aud":"other"}, {"iss":"https://evil.test"}, {"role":"service_role"}])
def test_signed_jwt_claims(configured, mutation):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    claims = {"sub":str(uuid4()), "aud":"authenticated", "iss":"https://example.supabase.co/auth/v1", "role":"authenticated", "iat":int(time.time()), "exp":int(time.time())+300}
    claims.update(mutation)
    token = jwt.encode(claims, key, algorithm="RS256", headers={"kid":"test"})
    class SigningKey:
        pass
    signing = SigningKey()
    signing.key = key.public_key()
    with patch("backend.auth.jwks_client") as client:
        client.return_value.get_signing_key_from_jwt.return_value = signing
        credentials = HTTPAuthorizationCredentials(scheme="Bearer",credentials=token)
        if mutation:
            with pytest.raises(HTTPException) as error:
                require_authenticated_user(credentials)
            assert error.value.status_code == 401
        else:
            assert require_authenticated_user(credentials) == claims["sub"]

def test_cross_user_download_and_report():
    from openpyxl import Workbook
    book=Workbook(); sheet=book.active; sheet.append(["Invoice Value","Taxable Value"]);sheet.append([118,100])
    stream=BytesIO();book.save(stream);book.close()
    client=TestClient(app)
    app.dependency_overrides[require_authenticated_user]=lambda:"owner"
    app.dependency_overrides[require_approved_user]=lambda:"owner"
    try:
        response=reviewed_post(client,"/api/excel/process",files={"file":("test.xlsx",stream.getvalue())},data={"worksheet":"Sheet","first_data_row":2,"invoice_col":1,"taxable_col":2})
        assert response.status_code == 200, response.text
        file_id=response.json()["file_id"]
        for kind in ["download","report"]:
            assert client.get(f"/api/excel/{kind}/{file_id}").status_code == 200
        app.dependency_overrides[require_authenticated_user]=lambda:"other"
        app.dependency_overrides[require_approved_user]=lambda:"other"
        for kind in ["download","report"]:
            assert client.get(f"/api/excel/{kind}/{file_id}").status_code == 404
    finally:
        app.dependency_overrides.clear()
