"""Production repository exercised through mocked private RPC/Storage transport.

Postgres function authorization/locking is tested separately against PGlite.
No Supabase network or production records are used here.
"""
from copy import deepcopy
import json
import time
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from backend.main import app,RESULTS
from backend.approvals import require_approved_user
from backend.review_store import durable,cleanup_reviews
from tests.test_splits import fixture,preview_confirm
from tests.test_reviews import save

OWNER='11111111-1111-4111-8111-111111111111'
OTHER='22222222-2222-4222-8222-222222222222'


class Transport:
    def __init__(self):self.items={};self.objects={};self.reads=[]

    def rpc(self,name,p):
        if name=='review_reserve':
            item=dict(id=p['p_id'],owner=p['p_user'],filename=p['p_filename'],source_hash=p['p_hash'],
                options=p['p_options'],analysis=p['p_analysis'],decisions={},result=None,version=1,state='uploading',
                created=time.time(),expires=time.time()+86400,lease_token=None,lease_until=None,artifact_tokens=[],
                artifact_reserved=0,cleanup_token=None,cleanup_until=None)
            self.items[item['id']]=deepcopy(item);return item
        if name=='review_list':return [dict(review_id=i['id'],filename=i['filename'],state=i['state']) for i in self.items.values() if i['owner']==p['p_user'] and i['state']!='deleted' and i['expires']>time.time()]
        if name=='review_orphan_paths':return []
        if name=='review_reconcile_claim':
            clock=time.time()
            candidates=[i for i in self.items.values() if i['expires']>clock and i.get('lease_token') and (i.get('lease_until') or 0)<=clock and i['state'] in {'open','generating'} and (i.get('cleanup_until') or 0)<clock and (p.get('p_id') is None or (i['id']==p['p_id'] and i['owner']==p['p_user']))]
            if not candidates:return None
            item=min(candidates,key=lambda i:i.get('lease_until',0))
            if item['state']=='generating':
                item.update(state='open',version=item['version']+1,lease_until=clock+120,cleanup_token=None,cleanup_until=None)
                return None
            item.update(cleanup_token=str(uuid4()),cleanup_until=clock+120)
            return deepcopy(item)
        if name=='review_reconcile_finish':
            item=self.items.get(p['p_id'])
            if not item or (item['owner'],item['state'],item.get('lease_token'),item.get('cleanup_token'))!=(p['p_user'],'open',p['p_attempt'],p['p_cleanup']):return False
            if p['p_artifact_bytes']>item['artifact_reserved']:raise HTTPException(409,'Reconciled artifacts exceed the held reservation.')
            item.update(artifact_reserved=p['p_artifact_bytes'],lease_token=None,lease_until=None,cleanup_token=None,cleanup_until=None)
            return True
        if name=='review_cleanup_claim':
            item=next((i for i in self.items.values() if i['state']=='deleted' or i['expires']<=time.time()),None)
            if item:item.update(state='deleted',cleanup_token=str(uuid4()))
            return deepcopy(item)
        if name=='review_cleanup_finish':
            if self.items[p['p_id']]['cleanup_token']==p['p_token']:del self.items[p['p_id']]
            return None
        item=self.items.get(p['p_id'])
        if item is None or item['owner']!=p['p_user'] or item['expires']<=time.time() or item['state']=='deleted':raise HTTPException(404,'Review session not found or expired.')
        if name=='review_activate':item['state']='open'
        elif name=='review_change':
            if (item['version'],item['state'],item['lease_token'])!=(p['p_version'],p['p_state'],p['p_token']):raise HTTPException(409,'Review changed.')
            change=p['p_change']
            if change['state']=='generating':
                if item.get('lease_token') is not None:raise HTTPException(409,'Previous generation attempt is awaiting artifact reconciliation.')
                item['lease_until']=time.time()+600;item['artifact_tokens'].append(change['lease_token'])
                item['artifact_reserved']+=100*1024*1024
            elif item['state']=='generating' and change['state']=='open':
                if change.get('lease_token')!=item.get('lease_token'):raise HTTPException(409,'Generation attempt token changed.')
                item['lease_until']=max(item.get('lease_until') or 0,time.time())+120
            elif item['state']=='open' and change['state']=='open' and change.get('lease_token')!=item.get('lease_token'):
                raise HTTPException(409,'Pending generation token is immutable.')
            if item['state']=='generating' and change['state']=='generated':
                sizes=change['result']['durable_artifact']
                item['artifact_reserved']=item['artifact_reserved']-100*1024*1024+sizes['output_bytes']+sizes['report_bytes']
                item['lease_until']=None
            item.update(deepcopy(change));item['version']+=1
        elif name!='review_get':raise AssertionError('Unknown review RPC')
        return deepcopy(item)

    def storage(self,method,path,body=None,**kwargs):
        if method=='DELETE':
            for name in json.loads(body)['prefixes']:self.objects.pop('gst-review-workbooks/'+name,None)
            return b''
        key=path.removeprefix('object/').removeprefix('authenticated/')
        if method=='POST' and key.startswith('list/'):
            bucket=key.removeprefix('list/')
            prefix=json.loads(body)['prefix']
            values=[]
            for object_key,data in self.objects.items():
                if object_key.startswith(bucket+'/'+prefix+'/'):
                    name=object_key.removeprefix(bucket+'/'+prefix+'/')
                    values.append({'name':name,'metadata':{'size':len(data)}})
            return json.dumps(values).encode()
        if method=='POST':
            if key in self.objects:raise HTTPException(503,'Immutable object exists.')
            self.objects[key]=body;return b'{}'
        assert method=='GET';self.reads.append(key)
        if key not in self.objects:raise HTTPException(503,'Private object unavailable.')
        return self.objects[key]


@pytest.fixture
def remote(monkeypatch):
    provider=Transport();monkeypatch.setenv('REVIEW_BACKEND','supabase')
    monkeypatch.setattr('backend.review_store.rpc',provider.rpc)
    monkeypatch.setattr('backend.review_store.storage_request',provider.storage)
    def history(*args,**kwargs):
        assert any(item['state']=='generated' for item in provider.items.values())
        return {'saved':False,'warning':'Test-only history unavailable.'}
    monkeypatch.setattr('backend.main.save_generated_file',history)
    app.dependency_overrides[require_approved_user]=lambda:OWNER
    yield TestClient(app),provider
    app.dependency_overrides.clear()


def start(client):
    raw,options,header,_=fixture()
    response=client.post('/api/excel/process',files={'file':('synthetic.xlsx',raw)},data=options)
    assert response.status_code==200,response.text
    return response.json(),raw,header


def complete(client,review,header):
    review=save(client,review,header+1,rates=[18,12]).json()
    review=preview_confirm(client,review,header+1)
    review=save(client,review,header+2,rates=[5,12,18]).json()
    return preview_confirm(client,review,header+2,[100,200,300])


def test_durable_full_split_workflow_restart_download_and_ownership(remote):
    client,provider=remote;review,raw,header=start(client)
    path='/api/excel/reviews/'+review['review_id']
    assert client.post(path+'/generate').status_code==409
    review=complete(client,review,header)
    response=client.post(path+'/generate');assert response.status_code==200,response.text
    result=response.json();assert result['review_download_id']==review['review_id']
    assert provider.items[review['review_id']]['artifact_reserved']==result['durable_artifact']['output_bytes']+result['durable_artifact']['report_bytes']
    assert client.get(path).json()['state']=='generated'
    output=client.get(path+'/download');assert output.status_code==200
    assert client.get(path+'/report').status_code==200
    # Discard every process-local result. Private persisted artifacts still work.
    RESULTS.clear()
    another_client=TestClient(app)
    assert another_client.get(path+'/download').content==output.content
    assert another_client.post(path+'/generate').json()['file_id']==result['file_id']
    source_key='gst-review-workbooks/'+OWNER+'/'+review['review_id']+'/source.xlsx'
    assert provider.objects[source_key]==raw
    app.dependency_overrides[require_approved_user]=lambda:OTHER
    assert another_client.get(path+'/download').status_code==404
    assert another_client.post(path+'/recover').status_code==404
    assert another_client.delete(path).status_code==404
    app.dependency_overrides[require_approved_user]=lambda:OWNER
    assert another_client.delete(path).status_code==200
    assert another_client.get(path+'/download').status_code==404
    cleanup_reviews()
    assert not provider.items and not provider.objects


@pytest.mark.parametrize('invalidate',['deleted','expired'])
def test_legacy_download_paths_cannot_bypass_durable_review_lifetime(remote,invalidate,monkeypatch):
    client,provider=remote;review,_,header=start(client)
    complete(client,review,header)
    path='/api/excel/reviews/'+review['review_id']
    from backend.review_store import SupabaseReviews
    publish=SupabaseReviews.publish
    def checked_publish(repository,item,*args):
        file_id=next(key for key,value in RESULTS.items() if value.get('durable_review_id')==review['review_id'])
        for kind in ('download','report'):
            assert TestClient(app).get('/api/excel/'+kind+'/'+file_id).status_code==409
        return publish(repository,item,*args)
    monkeypatch.setattr(SupabaseReviews,'publish',checked_publish)
    result=client.post(path+'/generate').json()
    assert client.get('/api/excel/download/'+result['file_id']).status_code==200
    assert client.get('/api/excel/report/'+result['file_id']).status_code==200
    if invalidate=='deleted':assert client.delete(path).status_code==200
    else:provider.items[review['review_id']]['expires']=0
    for kind in ('download','report'):
        assert client.get('/api/excel/'+kind+'/'+result['file_id']).status_code==404


def test_source_and_export_integrity_are_rechecked_and_errors_do_not_publish(remote):
    client,provider=remote;review,raw,header=start(client);review=complete(client,review,header)
    path='/api/excel/reviews/'+review['review_id']
    source_key='gst-review-workbooks/'+OWNER+'/'+review['review_id']+'/source.xlsx'
    provider.objects[source_key]=b'corrupted'
    assert client.post(path+'/generate').status_code==503
    assert client.get(path).json()['state']=='open'
    provider.items[review['review_id']]['lease_until']=0
    cleanup_reviews()
    provider.objects[source_key]=raw
    response=client.post(path+'/generate');assert response.status_code==200,response.text
    output_key=next(key for key in provider.objects if key.endswith('/output.xlsx'))
    provider.objects[output_key]=b'corrupted export'
    assert client.get(path+'/download').status_code==503


def test_failure_before_artifact_upload_reconciles_once_and_preserves_decisions(remote,monkeypatch):
    client,provider=remote;review,_,header=start(client);review=complete(client,review,header)
    path='/api/excel/reviews/'+review['review_id'];before=client.get(path).json()
    async def fail_before_generation(**kwargs):raise HTTPException(500,'Simulated failure before artifact upload.')
    monkeypatch.setattr('backend.main.generate_excel',fail_before_generation)
    response=client.post(path+'/generate')
    assert response.status_code==500
    pending=provider.items[review['review_id']]
    assert pending['state']=='open' and pending['lease_token']
    assert pending['artifact_reserved']==100*1024*1024
    pending['lease_until']=0
    cleanup_reviews()
    reconciled=provider.items[review['review_id']]
    assert reconciled['state']=='open' and reconciled['lease_token'] is None
    assert reconciled['artifact_reserved']==0
    assert client.get(path).json()['decisions']==before['decisions']
    cleanup_reviews()
    assert reconciled['artifact_reserved']==0


def test_partial_artifact_upload_is_accounted_instead_of_released(remote,monkeypatch):
    client,provider=remote;review,_,header=start(client);review=complete(client,review,header)
    path='/api/excel/reviews/'+review['review_id'];before=client.get(path).json()
    original=provider.storage
    def fail_report(method,storage_path,body=None,**kwargs):
        if method=='POST' and storage_path.endswith('/report.csv'):
            raise HTTPException(503,'Simulated response loss during report upload.')
        return original(method,storage_path,body,**kwargs)
    monkeypatch.setattr('backend.review_store.storage_request',fail_report)
    response=client.post(path+'/generate')
    assert response.status_code==503
    pending=provider.items[review['review_id']]
    assert pending['state']=='open' and pending['lease_token']
    token=pending['lease_token'];pending['lease_until']=0
    output_key=f"gst-review-workbooks/{OWNER}/{review['review_id']}/{token}/output.xlsx"
    output_size=len(provider.objects[output_key])
    assert pending['artifact_reserved']==100*1024*1024
    cleanup_reviews()
    assert pending['artifact_reserved']==output_size
    assert output_key in provider.objects  # Reconciliation accounts; it does not delete.
    assert client.get(path).json()['decisions']==before['decisions']
    cleanup_reviews()
    assert pending['artifact_reserved']==output_size


def test_uncertain_artifact_listing_retains_reservation(remote,monkeypatch,caplog):
    client,provider=remote;review,_,header=start(client);review=complete(client,review,header)
    path='/api/excel/reviews/'+review['review_id']
    async def fail_before_generation(**kwargs):raise HTTPException(500,'Simulated failure.')
    monkeypatch.setattr('backend.main.generate_excel',fail_before_generation)
    assert client.post(path+'/generate').status_code==500
    pending=provider.items[review['review_id']];pending['lease_until']=0
    def unavailable(*args,**kwargs):raise HTTPException(503,'Storage list is unavailable.')
    monkeypatch.setattr('backend.review_store.storage_request',unavailable)
    cleanup_reviews()
    assert pending['lease_token'] and pending['artifact_reserved']==100*1024*1024
    assert 'reservation reconciliation deferred' in caplog.text


def test_expired_lease_recovery_keeps_reservation_until_artifacts_are_accounted(remote):
    client,provider=remote;review,_,header=start(client);review=complete(client,review,header)
    path='/api/excel/reviews/'+review['review_id'];before=client.get(path).json()
    token=str(uuid4())
    provider.rpc('review_change',{'p_id':review['review_id'],'p_user':OWNER,'p_version':review['version'],'p_state':'open','p_token':None,
                                  'p_change':{'state':'generating','lease_token':token,'decisions':before['decisions'],'result':None}})
    pending=provider.items[review['review_id']];pending['lease_until']=0
    output_key=f'gst-review-workbooks/{OWNER}/{review["review_id"]}/{token}/output.xlsx'
    provider.objects[output_key]=b'partial recovery artifact'
    recovered=client.post(path+'/recover')
    assert recovered.status_code==200,recovered.text
    assert recovered.json()['state']=='open'
    assert recovered.json()['decisions']==before['decisions']
    assert pending['lease_token']==token and pending['artifact_reserved']==100*1024*1024
    pending['lease_until']=0
    cleanup_reviews()
    assert pending['artifact_reserved']==len(provider.objects[output_key])
    assert pending['lease_token'] is None


def test_maintenance_fences_crashed_generation_and_reconciles_without_deleting_review(remote):
    client,provider=remote;review,_,header=start(client);review=complete(client,review,header)
    path='/api/excel/reviews/'+review['review_id'];before=client.get(path).json()
    token=str(uuid4())
    provider.rpc('review_change',{'p_id':review['review_id'],'p_user':OWNER,'p_version':review['version'],'p_state':'open','p_token':None,
                                  'p_change':{'state':'generating','lease_token':token,'decisions':before['decisions'],'result':None}})
    pending=provider.items[review['review_id']];pending['lease_until']=0
    output_key=f'gst-review-workbooks/{OWNER}/{review["review_id"]}/{token}/output.xlsx'
    provider.objects[output_key]=b'crashed-worker partial output'
    cleanup_reviews()  # First pass fences the expired lease and starts quarantine.
    assert pending['state']=='open' and pending['lease_token']==token
    assert pending['artifact_reserved']==100*1024*1024
    assert client.get(path).json()['decisions']==before['decisions']
    assert client.get('/api/excel/reviews').json()['reviews']
    pending['lease_until']=0
    cleanup_reviews()  # Later pass accounts the token folder, retaining the active review.
    assert pending['state']=='open' and pending['lease_token'] is None
    assert pending['artifact_reserved']==len(provider.objects[output_key])
    assert client.get(path).status_code==200


def test_generation_quota_error_is_specific_and_keeps_saved_decisions(remote,monkeypatch):
    client,provider=remote;review,_,header=start(client);review=complete(client,review,header)
    path='/api/excel/reviews/'+review['review_id']
    before=client.get(path).json()
    original=provider.rpc
    def quota_on_generation(name,payload):
        if name=='review_change' and payload['p_change'].get('state')=='generating':
            raise HTTPException(507,'Private storage cannot reserve space for this generated workbook. No saved review decisions were replaced.')
        return original(name,payload)
    monkeypatch.setattr('backend.review_store.rpc',quota_on_generation)
    response=client.post(path+'/generate')
    assert response.status_code==507
    assert response.json()['detail'].startswith('Private storage cannot reserve space')
    after=client.get(path).json()
    assert after['state']=='open'
    assert after['version']==before['version']
    assert after['decisions']==before['decisions']


def test_separately_saved_history_keeps_its_existing_legacy_download_gates(remote,monkeypatch):
    client,_=remote;review,_,header=start(client);complete(client,review,header)
    monkeypatch.setattr('backend.main.save_generated_file',lambda *_,**__:{'saved':True})
    path='/api/excel/reviews/'+review['review_id']
    result=client.post(path+'/generate').json()
    assert RESULTS[result['file_id']]['history_saved'] is True
    def deleted(*_):raise HTTPException(404,'History record deleted or expired.')
    monkeypatch.setattr('backend.main.file_download',deleted);monkeypatch.setattr('backend.main.get_file',deleted)
    for kind in ('download','report'):
        assert client.get('/api/excel/'+kind+'/'+result['file_id']).status_code==404
    # Review and My Files are separate retained copies, with separate delete APIs.
    assert client.get(path+'/download').status_code==200


def test_production_cannot_silently_fall_back_to_local_files(monkeypatch):
    monkeypatch.setenv('APP_ENV','production');monkeypatch.setenv('REVIEW_BACKEND','sqlite')
    with pytest.raises(HTTPException) as failure:durable()
    assert failure.value.status_code==503
    monkeypatch.delenv('REVIEW_BACKEND');assert durable()


def test_render_cannot_select_sqlite_when_app_environment_is_omitted(monkeypatch):
    monkeypatch.delenv('APP_ENV',raising=False);monkeypatch.setenv('RENDER','true')
    monkeypatch.delenv('REVIEW_BACKEND',raising=False)
    assert durable()
    monkeypatch.setenv('REVIEW_BACKEND','sqlite')
    with pytest.raises(HTTPException) as failure:durable()
    assert failure.value.status_code==503


def test_development_legacy_schema_upgrade_is_serialized_without_losing_source(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    from backend.reviews import connect,owned
    monkeypatch.setenv('APP_ENV','development');monkeypatch.setenv('REVIEW_BACKEND','sqlite')
    monkeypatch.delenv('RENDER',raising=False)
    app.dependency_overrides[require_approved_user]=lambda:OWNER
    try:
        review,raw,_=start(TestClient(app))
        with connect() as db:
            db.execute('alter table reviews drop column lease_token')
            db.execute('alter table reviews drop column lease_until')
        barrier=Barrier(2)
        def reopen(_):
            barrier.wait(timeout=3)
            with connect() as db:
                assert {'lease_token','lease_until'}<={row[1] for row in db.execute('pragma table_info(reviews)')}
                return owned(db,review['review_id'],OWNER)['source']
        with ThreadPoolExecutor(max_workers=2) as pool:assert list(pool.map(reopen,range(2)))==[raw,raw]
    finally:app.dependency_overrides.clear()


def test_two_signed_authenticated_users_isolated_on_every_review_route(remote,monkeypatch,caplog):
    """Exercise real JWT verification and approval dependency; mock only service I/O."""
    import jwt
    from types import SimpleNamespace
    from cryptography.hazmat.primitives.asymmetric import rsa
    from concurrent.futures import ThreadPoolExecutor
    _,provider=remote;app.dependency_overrides.clear()
    origin='https://example.supabase.co';admin='33333333-3333-4333-8333-333333333333'
    monkeypatch.setenv('SUPABASE_URL',origin);monkeypatch.setenv('SUPABASE_PUBLISHABLE_KEY','test-public')
    monkeypatch.setenv('ADMIN_USER_ID',admin)
    key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
    monkeypatch.setattr('backend.auth.jwks_client',lambda _:SimpleNamespace(get_signing_key_from_jwt=lambda _:SimpleNamespace(key=key.public_key())))
    statuses={OWNER:'approved',OTHER:'approved'}
    def approval(name,payload):
        assert name=='approval_context' and payload['p_owner']==admin
        return dict(ready=True,email_verified=True,status=statuses[payload['p_user']],is_admin=False)
    monkeypatch.setattr('backend.approvals.rpc',approval)
    tokens={identity:jwt.encode(dict(sub=identity,iss=origin+'/auth/v1',aud='authenticated',role='authenticated',iat=int(time.time()),exp=int(time.time())+300),key,algorithm='RS256') for identity in statuses}
    clients={identity:TestClient(app,headers={'Authorization':'Bearer '+token}) for identity,token in tokens.items()}
    a,b=clients[OWNER],clients[OTHER]
    first,_,header=start(a);second,_,_=start(b)
    path='/api/excel/reviews/'+first['review_id']
    assert {i['review_id'] for i in a.get('/api/excel/reviews').json()['reviews']}=={first['review_id']}
    assert {i['review_id'] for i in b.get('/api/excel/reviews').json()['reviews']}=={second['review_id']}
    operations=[('GET','',None),('DELETE','',None),('POST','/generate',None),('POST','/recover',None),
        ('GET','/download',None),('GET','/report',None),
        ('POST',f'/rows/{header+1}',{'version':first['version'],'choice':'CORRECT'}),
        ('POST',f'/rows/{header+1}/split-preview',{'version':first['version']}),
        ('POST',f'/rows/{header+1}/split-confirm',{'version':first['version'],'preview_id':'guessed'})]
    for method,suffix,body in operations:
        assert b.request(method,path+suffix,json=body).status_code==404
        assert TestClient(app).request(method,path+suffix,json=body).status_code==401
    assert a.get(path,headers={'Authorization':'Bearer forged'}).status_code==401
    # The same authenticated owner cannot save two versions of one decision.
    def edit(_):return a.post(path+f'/rows/{header+1}',json={'version':first['version'],'choice':'CORRECT'}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:assert sorted(pool.map(edit,range(2)))==[200,409]
    first=complete(a,a.get(path).json(),header)
    result=a.post(path+'/generate');assert result.status_code==200,result.text
    statuses[OWNER]='revoked'
    for method,suffix,body in operations:assert a.request(method,path+suffix,json=body).status_code==403
    statuses[OWNER]='approved';provider.items[first['review_id']]['expires']=0
    for method,suffix,body in operations:assert a.request(method,path+suffix,json=body).status_code==404
    for kind in ('download','report'):assert a.get('/api/excel/'+kind+'/'+result.json()['file_id']).status_code==404
    assert all(token not in caplog.text for token in tokens.values())


def test_oversized_mapping_is_rejected_before_analysis(remote,monkeypatch):
    client,_=remote;raw,options,_,_=fixture()
    monkeypatch.setattr('backend.reviews.analyze',lambda *_:pytest.fail('Oversized options must not reach Excel analysis'))
    response=client.post('/api/excel/process',files={'file':('synthetic.xlsx',raw)},data={**options,'monetary_columns':json.dumps({'extra':'x'*65536})})
    assert response.status_code==413


@pytest.mark.parametrize('modern',[False,True])
def test_private_storage_transport_never_upserts_or_logs_provider_bodies(monkeypatch,caplog,modern):
    from io import BytesIO
    from urllib.error import HTTPError
    from backend.files import storage_request
    key='sb_secret_local_audit_placeholder' if modern else 'local-legacy-placeholder'
    monkeypatch.setenv('SUPABASE_URL','https://example.supabase.co')
    monkeypatch.setenv('SUPABASE_SERVICE_ROLE_KEY',key)
    def blocked(request,timeout):
        assert request.full_url=='https://example.supabase.co/storage/v1/object/gst-review-workbooks/fixed'
        assert request.get_header('X-upsert')=='false'
        assert request.get_header('Apikey')==key
        assert request.get_header('Authorization')==(None if modern else 'Bearer '+key)
        assert request.data==b'immutable original' and timeout==30
        raise HTTPError(request.full_url,403,'Forbidden',{},BytesIO(b'sensitive-provider-body'))
    monkeypatch.setattr('backend.files.urlopen',blocked)
    with pytest.raises(HTTPException) as error:storage_request('POST','object/gst-review-workbooks/fixed',b'immutable original')
    assert error.value.status_code==503
    assert key not in caplog.text and 'sensitive-provider-body' not in str(error.value.detail)+caplog.text
