"""Safe diagnostics must not expose untrusted provider text or request secrets."""
import hashlib
import json
from io import BytesIO
from email.message import Message
from unittest.mock import patch
from urllib.error import HTTPError

import pytest

from backend.notifications import http_error_diagnostics, runtime_diagnostics, main


@pytest.mark.parametrize('body,code', [
    (b'error code: 1010', 'edge_1010'),
    (b'<html>Error 1010 Access denied</html>', 'edge_1010'),
    (b'{"name":"validation_error","message":"You can only send testing emails to private@gmail.com"}', 'test_sender_restriction'),
    (b'{"name":"restricted_api_key","message":"private applicant name"}', 'restricted_api_key'),
    (b'{"name":"re_private-secret","message":"private applicant name"}', 'unrecognized'),
    (b'{"name":[],"message":{}}', 'unrecognized'),
    (b'[]', 'unrecognized'),
])
def test_error_diagnostics_only_emit_allowlisted_summaries(body,code):
    headers=Message()
    headers['Content-Type']='text/html; private-secret'
    headers['Server']='cloudflare'
    headers['CF-Ray']='1234567890abcdef-IAD'
    headers['Retry-After']='30'
    headers['Authorization']='Bearer private-secret'
    headers['Set-Cookie']='private-secret'
    failure=HTTPError('https://api.resend.com/emails',403,'private-secret',headers,BytesIO(body))
    result=http_error_diagnostics(failure)
    assert result['status']==403
    assert result['code']==code
    assert result['server']=='cloudflare'
    assert result['cf_ray']=='1234567890abcdef-IAD'
    assert result['retry_after_seconds']==30
    assert 'private' not in json.dumps(result)


def test_arbitrary_metadata_is_not_logged():
    headers={'Content-Type':'applicant@example.com','Server':'re_secret',
             'CF-Ray':'Bearer re_secret','Retry-After':'applicant name'}
    result=http_error_diagnostics(HTTPError('https://api.resend.com/emails',403,'',headers,BytesIO(b'private')))
    assert result['content_type']=='other'
    assert result['server']=='other'
    assert result['cf_ray'] is None
    assert result['retry_after_seconds'] is None


def test_key_comparison_is_offline_and_never_exposes_secret(monkeypatch,capsys):
    key='re_fake-unit-test-key'
    monkeypatch.setenv('RESEND_API_KEY',' '+key+' ')
    monkeypatch.setenv('RESEND_EXPECTED_KEY_SHA256',hashlib.sha256(key.encode()).hexdigest())
    result=runtime_diagnostics()
    assert result['expected_key_matches'] is True
    assert result['key_format_valid'] is True
    assert result['key_whitespace_trimmed'] is True
    assert key not in json.dumps(result)
    monkeypatch.setenv('RESEND_EXPECTED_KEY_SHA256','0'*64)
    assert runtime_diagnostics()['expected_key_matches'] is False
    with patch('sys.argv',['notifications','--check-config']), patch('backend.notifications.rpc') as db, patch('backend.notifications.urlopen') as http:
        main()
        db.assert_not_called()
        http.assert_not_called()
    assert key not in capsys.readouterr().out
