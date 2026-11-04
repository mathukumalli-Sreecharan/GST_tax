import json
import time
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi import HTTPException

from backend.review_store import BUCKET, cleanup_deleted_reviews

TARGET_A='11111111-1111-4111-8111-111111111111'
TARGET_B='22222222-2222-4222-8222-222222222222'
OTHER_DELETED='33333333-3333-4333-8333-333333333333'
OPEN_REVIEW='44444444-4444-4444-8444-444444444444'
GENERATED_REVIEW='55555555-5555-4555-8555-555555555555'
OWNER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
TOKEN_A='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
TOKEN_B='cccccccc-cccc-4ccc-8ccc-cccccccccccc'


class TargetCleanupTransport:
    def __init__(self):
        self.items={
            TARGET_A:self.item(TARGET_A,'deleted',314572800,[TOKEN_A]),
            TARGET_B:self.item(TARGET_B,'deleted',209715200,[TOKEN_B]),
            OTHER_DELETED:self.item(OTHER_DELETED,'deleted',1000,[]),
            OPEN_REVIEW:self.item(OPEN_REVIEW,'open',1000,[]),
            GENERATED_REVIEW:self.item(GENERATED_REVIEW,'generated',1000,[]),
        }
        self.objects=set()
        self.rpc_calls=[]
        self.deleted_paths=[]
        self.fail_delete=False
        self.keep_after_delete=set()
        for item in self.items.values():
            self.objects.update(BUCKET+'/'+path for path in self.paths(item))

    @staticmethod
    def item(review_id,state,reserved,tokens):
        return {'id':review_id,'owner':OWNER,'state':state,'artifact_reserved':reserved,
                'artifact_tokens':tokens,'cleanup_token':None,'cleanup_until':None,'lease_until':None}

    @staticmethod
    def paths(item):
        base=f"{item['owner']}/{item['id']}"
        values=[base+'/source.xlsx']
        for token in item['artifact_tokens']:
            values += [base+'/'+token+'/output.xlsx',base+'/'+token+'/report.csv']
        return values

    def rpc(self,name,payload):
        self.rpc_calls.append((name,deepcopy(payload)))
        review_id=payload.get('p_id')
        item=self.items.get(review_id)
        if name=='review_cleanup_claim_target':
            if item is None:raise HTTPException(404,'Target deleted review was not found.')
            if item['state']!='deleted':raise HTTPException(409,'Target review is not in deleted state.')
            if item['artifact_reserved']!=payload['p_expected_reserved']:
                raise HTTPException(409,'Target review reservation changed.')
            now=time.time()
            if item.get('lease_until') and item['lease_until']>=now:raise HTTPException(409,'Active generation lease.')
            if item.get('cleanup_until') and item['cleanup_until']>=now:raise HTTPException(409,'Active cleanup lease.')
            item.update(cleanup_token=str(uuid4()),cleanup_until=now+600)
            return deepcopy(item)
        if name=='review_cleanup_finish_target':
            if item is None:return False
            if item['state']!='deleted' or item.get('cleanup_token')!=payload['p_token'] or item.get('cleanup_until',0)<=time.time():return False
            del self.items[review_id]
            return True
        raise AssertionError(f'Unexpected RPC {name}; general cleanup must not run.')

    def storage(self,method,path,body=None,**kwargs):
        if method=='DELETE':
            assert path=='object/'+BUCKET
            paths=json.loads(body)['prefixes']
            assert paths and all('/' in value and not value.startswith('/') for value in paths)
            self.deleted_paths.append(paths)
            if self.fail_delete:raise HTTPException(503,'Private file storage is temporarily unavailable.')
            for value in paths:
                object_key=BUCKET+'/'+value
                if value not in self.keep_after_delete:self.objects.discard(object_key)
            return b''
        assert method=='POST' and path=='object/list/'+BUCKET
        prefix=json.loads(body)['prefix']
        base=BUCKET+'/'+prefix+'/'
        names=set()
        for object_key in self.objects:
            if object_key.startswith(base):names.add(object_key[len(base):].split('/',1)[0])
        return json.dumps([{'name':name} for name in sorted(names)]).encode()


@pytest.fixture
def cleanup_transport(monkeypatch):
    transport=TargetCleanupTransport()
    monkeypatch.setattr('backend.review_store.rpc',transport.rpc)
    monkeypatch.setattr('backend.review_store.storage_request',transport.storage)
    yield transport


def test_target_cleanup_only_deletes_the_two_explicit_ids(cleanup_transport):
    transport=cleanup_transport
    targets={TARGET_A:314572800,TARGET_B:209715200}
    result=cleanup_deleted_reviews(targets)
    assert [row['review_id'] for row in result['reviews']]==[TARGET_A,TARGET_B]
    assert all(row['cleaned'] for row in result['reviews'])
    assert {call[1]['p_id'] for call in transport.rpc_calls if call[0]=='review_cleanup_claim_target'}==set(targets)
    assert all(call[0] in {'review_cleanup_claim_target','review_cleanup_finish_target'} for call in transport.rpc_calls)
    assert set(transport.items)=={OTHER_DELETED,OPEN_REVIEW,GENERATED_REVIEW}
    assert not any(path.startswith(f'{OWNER}/{OTHER_DELETED}/') or path.startswith(f'{OWNER}/{OPEN_REVIEW}/') or path.startswith(f'{OWNER}/{GENERATED_REVIEW}/')
                   for group in transport.deleted_paths for path in group)
    assert all(any(path.startswith(f'{OWNER}/{target}/') for target in targets)
               for group in transport.deleted_paths for path in group)


def test_open_and_generated_targets_are_refused_without_storage_calls(cleanup_transport):
    transport=cleanup_transport
    result=cleanup_deleted_reviews({OPEN_REVIEW:314572800,GENERATED_REVIEW:209715200})
    assert all(not row['cleaned'] for row in result['reviews'])
    assert all('not in deleted state' in row['detail'] for row in result['reviews'])
    assert transport.deleted_paths==[]
    assert OPEN_REVIEW in transport.items and GENERATED_REVIEW in transport.items
    assert OTHER_DELETED in transport.items


def test_active_cleanup_or_generation_lease_stops_only_that_record(cleanup_transport):
    transport=cleanup_transport
    transport.items[TARGET_A]['cleanup_until']=time.time()+100
    transport.items[TARGET_B]['lease_until']=time.time()+100
    result=cleanup_deleted_reviews({TARGET_A:314572800,TARGET_B:209715200})
    assert all(not row['cleaned'] for row in result['reviews'])
    assert transport.deleted_paths==[]
    assert TARGET_A in transport.items and TARGET_B in transport.items


def test_storage_failure_does_not_finish_or_remove_target(cleanup_transport):
    transport=cleanup_transport;transport.fail_delete=True
    result=cleanup_deleted_reviews({TARGET_A:314572800,TARGET_B:209715200})
    assert all(not row['cleaned'] for row in result['reviews'])
    assert not any(name=='review_cleanup_finish_target' for name,_ in transport.rpc_calls)
    assert TARGET_A in transport.items and TARGET_B in transport.items


def test_unconfirmed_deletion_does_not_finish(cleanup_transport):
    transport=cleanup_transport
    transport.keep_after_delete.add(f'{OWNER}/{TARGET_A}/{TOKEN_A}/output.xlsx')
    result=cleanup_deleted_reviews({TARGET_A:314572800,TARGET_B:209715200})
    by_id={row['review_id']:row for row in result['reviews']}
    assert not by_id[TARGET_A]['cleaned']
    assert by_id[TARGET_B]['cleaned']
    assert 'remains in Storage' in by_id[TARGET_A]['detail']
    assert not any(name=='review_cleanup_finish_target' and payload['p_id']==TARGET_A for name,payload in transport.rpc_calls)
    assert TARGET_A in transport.items and TARGET_B not in transport.items


def test_success_uses_exact_paths_and_repeated_execution_is_safe(cleanup_transport):
    transport=cleanup_transport
    first=cleanup_deleted_reviews({TARGET_A:314572800,TARGET_B:209715200})
    expected_a=transport.paths(TargetCleanupTransport.item(TARGET_A,'deleted',0,[TOKEN_A]))
    expected_b=transport.paths(TargetCleanupTransport.item(TARGET_B,'deleted',0,[TOKEN_B]))
    assert transport.deleted_paths==[expected_a,expected_b]
    assert all(row['paths'] in (expected_a,expected_b) for row in first['reviews'])
    delete_count=len(transport.deleted_paths);rpc_count=len(transport.rpc_calls)
    second=cleanup_deleted_reviews({TARGET_A:314572800,TARGET_B:209715200})
    assert all(not row['cleaned'] for row in second['reviews'])
    assert len(transport.deleted_paths)==delete_count
    assert len(transport.rpc_calls)==rpc_count+2  # Exact-ID claims only; missing rows are idempotent.
    assert set(transport.items)=={OTHER_DELETED,OPEN_REVIEW,GENERATED_REVIEW}


@pytest.mark.parametrize('targets',[{}, {TARGET_A:314572800},
                                     {TARGET_A:314572800,TARGET_B:314572800},
                                     {TARGET_A:314572800,TARGET_B:209715200,OTHER_DELETED:1000}])
def test_cleanup_requires_exactly_two_expected_reservations_before_any_rpc(cleanup_transport,targets):
    with pytest.raises(HTTPException):cleanup_deleted_reviews(targets)
    assert cleanup_transport.rpc_calls==[]
    assert cleanup_transport.deleted_paths==[]
