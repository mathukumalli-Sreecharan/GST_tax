from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend.main import app
from backend.security import validate_upload_package, validate_production_config


def package(xml):
    out=BytesIO()
    with ZipFile(out,'w',ZIP_DEFLATED) as archive:
        archive.writestr('xl/worksheets/sheet1.xml',xml)
    return out.getvalue()


@pytest.mark.parametrize('xml,status',[
 ('<worksheet><dimension ref="A1:XFD1048576"/></worksheet>',413),
 ('<worksheet><sheetData><c r="XFD1048576"/></sheetData></worksheet>',413),
 ('<!DOCTYPE x [<!ENTITY boom "boom">]><worksheet>&boom;</worksheet>',422),
 ('<broken',422),
 ('<worksheet><c r="invalid-cell"/></worksheet>',422),
])
def test_unsafe_or_unbounded_workbook_parts_rejected(xml,status):
    with pytest.raises(HTTPException) as exc:validate_upload_package(package(xml))
    assert exc.value.status_code==status


def test_body_limit_rejects_before_multipart_parsing():
    response=TestClient(app).post('/api/excel/inspect',content=b'',headers={'Content-Length':str(22*1024*1024)})
    assert response.status_code==413


def test_production_requires_explicit_https_origins(monkeypatch):
    monkeypatch.setenv('APP_ENV','production')
    monkeypatch.setenv('SUPABASE_URL','https://example.supabase.co')
    monkeypatch.setenv('APP_BASE_URL','https://gst.example.com')
    monkeypatch.setenv('CORS_ORIGINS','https://gst.example.com')
    validate_production_config()
    for bad in ('*','http://gst.example.com','https://*.example.com',''):
        monkeypatch.setenv('CORS_ORIGINS',bad)
        with pytest.raises(RuntimeError):validate_production_config()
