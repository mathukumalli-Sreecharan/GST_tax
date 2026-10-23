"""Regression runs must never use real privileged service credentials."""
import pytest


@pytest.fixture(autouse=True)
def no_live_privileged_services(monkeypatch):
    monkeypatch.delenv("SUPABASE_SERVICE_ROLE_KEY", raising=False)
    monkeypatch.delenv("RESEND_API_KEY", raising=False)
