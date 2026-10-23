from io import BytesIO
import json
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from openpyxl import Workbook

from backend.auth import require_authenticated_user
from backend.approvals import approval_state, require_admin
from backend.main import app
from backend.notifications import deliver_notifications

OWNER, USER, OTHER = (str(uuid4()) for _ in range(3))


@pytest.fixture
def access(monkeypatch):
    monkeypatch.setenv('ADMIN_USER_ID', OWNER)
    state = {'ready': True, 'status': 'pending', 'email_verified': True, 'is_admin': False}
    calls = []
    def rpc(name, params):
        calls.append((name, params))
        if name == 'approval_context':
            return dict(state)
        if name == 'admin_approval_list':
            return {'users': [], 'counts': {'total': 0}}
        if name == 'change_approval':
            return {'user_id': params['p_user'], 'status': params['p_status']}
        raise AssertionError(name)
    monkeypatch.setattr('backend.approvals.rpc', rpc)
    app.dependency_overrides[require_authenticated_user] = lambda: USER
    yield TestClient(app), state, calls
    app.dependency_overrides.clear()


def upload():
    wb = Workbook()
    wb.active.append(['Invoice Value', 'Taxable Value'])
    for rate in (5, 12, 18, 28):
        wb.active.append([100+rate, 100])
    stream = BytesIO()
    wb.save(stream)
    wb.close()
    return {'file': ('source.xlsx', stream.getvalue())}


@pytest.mark.parametrize('status', ['pending', 'rejected', 'revoked'])
@pytest.mark.parametrize('endpoint', ['inspect', 'process', 'download/id', 'report/id'])
def test_all_excel_endpoints_check_approval(access, status, endpoint):
    client, state, calls = access
    state['status'] = status
    if endpoint in ('inspect', 'process'):
        response = client.post('/api/excel/'+endpoint, files=upload(), data={
            'worksheet':'Sheet', 'first_data_row':2, 'invoice_col':1, 'taxable_col':2})
    else:
        response = client.get('/api/excel/'+endpoint)
    assert response.status_code == 403
    assert calls[-1][0] == 'approval_context'
    assert calls[-1][1]['p_user'] == USER


def test_approval_endpoint_pending_and_unverified(access):
    client, state, _ = access
    response = client.get('/api/account/approval')
    assert response.json()['status'] == 'pending'
    assert response.headers['cache-control'] == 'private, no-store'
    state.update(status='approved', email_verified=False)
    assert client.post('/api/excel/inspect', files=upload()).status_code == 403


def test_approved_processing_then_revocation_and_cross_user_download(access):
    client, state, _ = access
    state['status'] = 'approved'
    response = client.post('/api/excel/process', files=upload(), data={
        'worksheet':'Sheet', 'first_data_row':2, 'invoice_col':1, 'taxable_col':2})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['summary']['rate_counts'] == {'5':1,'12':1,'18':1,'28':1}
    for kind in ('download', 'report'):
        endpoint = f'/api/excel/{kind}/{result["file_id"]}'
        assert client.get(endpoint).status_code == 200
        app.dependency_overrides[require_authenticated_user] = lambda: OTHER
        assert client.get(endpoint).status_code == 404
        app.dependency_overrides[require_authenticated_user] = lambda: USER
        state['status'] = 'revoked'
        assert client.get(endpoint).status_code == 403
        state['status'] = 'approved'


def test_owner_setup_is_required_and_outages_fail_closed(access, monkeypatch):
    client, state, _ = access
    state.update(ready=False, status='approved')
    assert client.post('/api/excel/inspect', files=upload()).status_code == 503
    state['ready'] = True
    def unavailable(*args):
        raise HTTPException(503, 'Unavailable')
    monkeypatch.setattr('backend.approvals.rpc', unavailable)
    assert client.post('/api/excel/inspect', files=upload()).status_code == 503
    monkeypatch.delenv('ADMIN_USER_ID')
    with pytest.raises(HTTPException) as exc:
        require_admin(USER)
    assert exc.value.status_code == 503


def test_non_owner_admin_api_is_rejected_before_database_call(access):
    client, _, calls = access
    assert client.get('/api/admin/approvals').status_code == 403
    assert client.post('/api/admin/approvals/'+OTHER, json={'status':'approved','expected_status':'pending'}).status_code == 403
    assert calls == []


def test_unauthenticated_admin_api_requires_jwt():
    client = TestClient(app)
    assert client.get('/api/admin/approvals').status_code == 401
    assert client.post('/api/admin/approvals/'+USER, json={'status':'approved','expected_status':'pending'}).status_code == 401


@pytest.mark.parametrize('status,prior', [('approved','pending'),('rejected','pending'),('revoked','approved')])
def test_owner_actions_use_verified_actor_and_validate_input(access, status, prior):
    client, state, calls = access
    app.dependency_overrides[require_authenticated_user] = lambda: OWNER
    state.update(status='approved', is_admin=True)
    response = client.post('/api/admin/approvals/'+USER, json={'status':status,'expected_status':prior})
    assert response.status_code == 200
    assert calls[-1] == ('change_approval', {'p_actor':OWNER,'p_owner':OWNER,'p_user':USER,'p_status':status,'p_expected':prior})
    response = client.post('/api/admin/approvals/'+USER, json={'status':status,'expected_status':prior,'actor_id':OTHER})
    assert response.status_code == 422
    assert client.post('/api/admin/approvals/'+OWNER,json={'status':'revoked','expected_status':'approved'}).status_code == 409
    assert client.get('/api/admin/approvals?status=invalid').status_code == 422
    assert client.get('/api/admin/approvals').status_code == 200


@pytest.fixture
def email_config(monkeypatch):
    for key, value in {'RESEND_API_KEY':'test-server-secret','EMAIL_FROM':'Access <access@example.com>',
                       'ADMIN_NOTIFICATION_EMAIL':'owner@gmail.com','APP_BASE_URL':'https://gst.example.com'}.items():
        monkeypatch.setenv(key,value)


@pytest.mark.parametrize('fails', [False, True])
def test_email_delivery_and_failure_retains_outbox(email_config, fails):
    item = {'id':str(uuid4()),'lease_token':str(uuid4()),'kind':'request','payload':{
        'from':'Access <access@example.com>','to':['owner@gmail.com'],'subject':'Request','text':'Verified applicant'}}
    with patch('backend.notifications.rpc', side_effect=[item,None,None]) as database, patch('backend.notifications.urlopen') as provider:
        if fails:
            provider.side_effect = URLError('timeout')
        else:
            provider.return_value.__enter__.return_value.read.return_value = b'{"id":"email-1"}'
        assert deliver_notifications(limit=1) == (0 if fails else 1)
        request = provider.call_args.args[0]
        assert request.get_header('Idempotency-key') == 'gst-approval/'+item['id']
        assert json.loads(request.data) == item['payload']
        call, params = database.call_args.args
        assert call == 'finish_approval_notification'
        assert params['p_id'] == item['id'] and params['p_lease'] == item['lease_token']
        assert bool(params['p_error']) is fails
        assert 'test-server-secret' not in str(params)


def test_unconfigured_email_never_consumes_requests(monkeypatch):
    monkeypatch.delenv('RESEND_API_KEY',raising=False)
    with patch('backend.notifications.rpc') as database:
        assert deliver_notifications() == 0
        database.assert_not_called()


def test_retry_uses_identical_payload_and_key(email_config):
    item = {'id':str(uuid4()),'lease_token':str(uuid4()),'kind':'request','payload':{'from':'Access <access@example.com>','subject':'Request','text':'Frozen message','to':['owner@gmail.com']}}
    with patch('backend.notifications.rpc',side_effect=[item,None,item,None]), patch('backend.notifications.urlopen') as provider:
        provider.side_effect=URLError('response lost')
        deliver_notifications(limit=1)
        deliver_notifications(limit=1)
        first, second = [call.args[0] for call in provider.call_args_list]
        assert first.data == second.data
        assert first.get_header('Idempotency-key') == second.get_header('Idempotency-key')


@pytest.mark.parametrize('status,code,message', [
    (404, 'PGRST202', 'migration is missing'),
    (400, '42P01', 'migration is missing'),
    (401, 'PGRST301', 'rejected the backend credentials'),
])
def test_setup_errors_are_specific_without_exposing_credentials(monkeypatch, status, code, message):
    from backend.approvals import rpc
    monkeypatch.setenv('SUPABASE_URL', 'https://example.supabase.co')
    monkeypatch.setenv('SUPABASE_SERVICE_ROLE_KEY', 'private-server-credential')
    failure = HTTPError('https://example.supabase.co', status, 'failure', {},
                        BytesIO(json.dumps({'code': code, 'message': 'sensitive database details'}).encode()))
    with patch('backend.approvals.urlopen', side_effect=failure):
        with pytest.raises(HTTPException) as exc:
            rpc('initialize_approval_owner', {'p_owner': OWNER})
    assert exc.value.status_code == 503
    assert message in exc.value.detail
    assert 'private-server-credential' not in exc.value.detail
    assert 'sensitive database details' not in exc.value.detail


def test_testing_sender_403_records_actionable_diagnostic(email_config,monkeypatch):
    sender='GST Ledger Studio <onboarding@resend.dev>'
    monkeypatch.setenv('EMAIL_FROM',sender)
    item={'id':str(uuid4()),'lease_token':str(uuid4()),'kind':'request','payload':{
        'from':sender,'to':['owner@gmail.com'],'subject':'Request','text':'Applicant'}}
    failure=HTTPError('https://api.resend.com/emails',403,'Forbidden',{},BytesIO(b'sensitive provider details'))
    with patch('backend.notifications.rpc',side_effect=[item,None]) as db,patch('backend.notifications.urlopen',side_effect=failure):
        assert deliver_notifications(limit=1)==0
        details=db.call_args.args[1]
        assert 'Resend account owner Gmail' in details['p_error']
        assert 'sensitive' not in details['p_error']
        assert details['p_provider_id'] is None

@pytest.mark.parametrize('change', [
    {'kind':'approved'}, {'kind':'rejected'}, {'kind':'revoked'},
    {'to':['applicant@example.com']}, {'bcc':['applicant@example.com']},
    {'from':'old@example.com'},
])
def test_non_admin_or_decision_payload_is_never_sent(email_config, change):
    item={'id':str(uuid4()),'lease_token':str(uuid4()),'kind':'request','payload':{
        'from':'Access <access@example.com>','to':['owner@gmail.com'],'subject':'Request','text':'Applicant'}}
    if 'kind' in change:
        item.update(change)
    else:
        item['payload'].update(change)
    with patch('backend.notifications.rpc',side_effect=[item,None]) as db, patch('backend.notifications.urlopen') as provider:
        assert deliver_notifications(limit=1)==0
        provider.assert_not_called()
        assert 'blocked' in db.call_args.args[1]['p_error']


def test_failed_delivery_recovers_with_original_idempotency_key(email_config):
    item={'id':str(uuid4()),'lease_token':str(uuid4()),'kind':'request','payload':{
        'from':'Access <access@example.com>','to':['owner@gmail.com'],'subject':'Request','text':'Applicant'}}
    with patch('backend.notifications.rpc',side_effect=[item,None,item,None,None]) as db, patch('backend.notifications.urlopen') as provider:
        provider.side_effect=URLError('timeout')
        assert deliver_notifications(limit=1)==0
        assert db.call_args.args[1]['p_error']
        provider.side_effect=None
        provider.return_value.__enter__.return_value.read.return_value=b'{"id":"accepted"}'
        assert deliver_notifications(limit=1)==1
        assert db.call_args.args[1]['p_provider_id']=='accepted'
        assert deliver_notifications(limit=1)==0
        first,second=[c.args[0] for c in provider.call_args_list]
        assert first.data==second.data
        assert first.get_header('Idempotency-key')==second.get_header('Idempotency-key')


@pytest.mark.parametrize('recipient',['other@example.com','owner@gmail.com,other@gmail.com','Owner <owner@gmail.com>'])
def test_invalid_admin_configuration_does_not_claim(email_config,monkeypatch,recipient):
    monkeypatch.setenv('ADMIN_NOTIFICATION_EMAIL',recipient)
    with patch('backend.notifications.rpc') as db:
        assert deliver_notifications()==0
        db.assert_not_called()
