"""Private durable review repository. No production fallback to local storage."""
import hashlib
import json
import logging
import os
import re
import time
from uuid import UUID
from urllib.parse import quote
from fastapi import HTTPException
from backend.approvals import rpc as service_rpc
from backend.files import storage_request

BUCKET = 'gst-review-workbooks'
MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
MAX_ARTIFACT_BYTES = 50 * 1024 * 1024
logger = logging.getLogger(__name__)


def rpc(name,payload):
    try:return service_rpc(name,payload)
    except HTTPException as exc:
        messages={404:'Review session not found or expired.',403:'Approved review access required.'}
        if exc.status_code in messages:raise HTTPException(exc.status_code,messages[exc.status_code]) from None
        if exc.status_code==503:raise HTTPException(503,'Private review persistence is unavailable or migration 007 is missing. Check the server-only Supabase configuration.') from None
        raise


def durable():
    production = os.getenv('APP_ENV', '').strip().lower() == 'production' or os.getenv('RENDER', '').lower() == 'true'
    mode = os.getenv('REVIEW_BACKEND', 'supabase' if production else 'sqlite')
    if mode not in {'sqlite', 'supabase'} or production and mode != 'supabase':
        raise HTTPException(503, 'Production review sessions require private Supabase persistence.')
    return mode == 'supabase'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def identity(value):
    try:
        return str(UUID(value))
    except (ValueError, TypeError):
        raise HTTPException(404, 'Review session not found or expired.') from None


def decode(item):
    result = dict(item)
    for key in ('options', 'analysis', 'decisions', 'result'):
        if result.get(key) is not None:
            result[key] = json.dumps(result[key])
    return result


class SupabaseReviews:
    def get(self, review_id, owner):
        return decode(rpc('review_get', {'p_id': identity(review_id), 'p_user': identity(owner)}))

    def list(self, owner):
        return rpc('review_list', {'p_user': identity(owner)})

    def create(self, review_id, owner, filename, source, options, analysis):
        if len(json.dumps(analysis).encode())>50*1024*1024:
            raise HTTPException(413,'Review analysis exceeds the private metadata limit.')
        item = rpc('review_reserve', {'p_id':identity(review_id), 'p_user':identity(owner),
                   'p_filename':filename, 'p_size':len(source), 'p_hash':digest(source),
                   'p_options':options, 'p_analysis':analysis})
        # Reservation survives failed/ambiguous uploads for cleanup. Never upsert originals.
        storage_request('POST', 'object/'+BUCKET+'/'+self.source_path(item), source)
        if digest(storage_request('GET', 'object/authenticated/'+BUCKET+'/'+self.source_path(item))) != digest(source):
            raise HTTPException(503, 'Original workbook upload could not be verified.')
        return decode(rpc('review_activate', {'p_id':review_id, 'p_user':owner}))

    def source_path(self, item):
        return f"{identity(item['owner'])}/{identity(item['id'])}/source.xlsx"

    def source(self, item):
        data = storage_request('GET', 'object/authenticated/'+BUCKET+'/'+self.source_path(item))
        if digest(data) != item['source_hash']:
            raise HTTPException(503, 'Original workbook integrity check failed; export is blocked.')
        return data

    def save(self, item, previous):
        patch = {key:item.get(key) for key in ('state','lease_token','decisions','result')}
        for key in ('decisions','result'):
            if isinstance(patch.get(key),str):patch[key]=json.loads(patch[key])
        saved = rpc('review_change', {'p_id':item['id'], 'p_user':item['owner'],
                    'p_version':previous['version'], 'p_state':previous['state'],
                    'p_token':previous.get('lease_token'), 'p_change':patch})
        item.update(decode(saved))

    def publish(self, item, output, report):
        token = identity(item['lease_token'])
        base = f"{identity(item['owner'])}/{identity(item['id'])}/{token}"
        output_bytes, report_bytes = output.read_bytes(), report.read_bytes()
        if len(output_bytes) > MAX_ARTIFACT_BYTES or len(report_bytes)>MAX_ARTIFACT_BYTES:
            raise HTTPException(413,'Generated review artifacts exceed the private storage limit.')
        for name,data,mime in [('output.xlsx',output_bytes,MIME),('report.csv',report_bytes,'text/csv')]:
            fresh=self.get(item['id'],item['owner'])
            if fresh['state']!='generating' or fresh.get('lease_token')!=token or (fresh.get('lease_until') or 0)<=time.time():
                raise HTTPException(409,'Generation lease is no longer active; no artifact was published.')
            storage_request('POST','object/'+BUCKET+'/'+base+'/'+name,data,content_type=mime)
            if digest(storage_request('GET','object/authenticated/'+BUCKET+'/'+base+'/'+name)) != digest(data):
                raise HTTPException(503,'Generated artifact integrity verification failed.')
        return {'token':token, 'output_hash':digest(output_bytes), 'report_hash':digest(report_bytes),
                'output_bytes':len(output_bytes),'report_bytes':len(report_bytes)}

    def reconcile_claim(self, item):
        """Account all token-scoped objects before releasing a held reservation."""
        owner, review_id = identity(item['owner']), identity(item['id'])
        tokens = item.get('artifact_tokens') or []
        if not isinstance(tokens, list) or len(tokens) > 8:
            raise HTTPException(503, 'Generation reservation metadata could not be validated.')
        total = 0
        allowed = {'output.xlsx', 'report.csv'}
        for value in tokens:
            token = identity(value)
            prefix = f'{owner}/{review_id}/{token}'
            raw = storage_request('POST', 'object/list/'+BUCKET,
                                  json.dumps({'prefix':prefix,'limit':10,'offset':0,
                                              'sortBy':{'column':'name','order':'asc'}}).encode(),
                                  content_type='application/json')
            try:
                entries = json.loads(raw)
            except (TypeError, ValueError):
                raise HTTPException(503, 'Generated artifact listing could not be validated.') from None
            if not isinstance(entries, list) or len(entries) > 2:
                raise HTTPException(503, 'Generated artifact listing could not be validated.')
            seen = set()
            token_bytes = 0
            for entry in entries:
                if not isinstance(entry, dict) or entry.get('name') not in allowed or entry['name'] in seen:
                    raise HTTPException(503, 'Unexpected object found under a generation token; reservation retained.')
                seen.add(entry['name'])
                metadata = entry.get('metadata')
                size = metadata.get('size') if isinstance(metadata, dict) else None
                if isinstance(size, bool) or not (isinstance(size, int) or isinstance(size, str) and re.fullmatch(r'\d+', size)):
                    raise HTTPException(503, 'Generated artifact size is unavailable; reservation retained.')
                size = int(size)
                if not 0 <= size <= MAX_ARTIFACT_BYTES:
                    raise HTTPException(503, 'Generated artifact exceeds its supported limit; reservation retained.')
                token_bytes += size
            if token_bytes > 2 * MAX_ARTIFACT_BYTES:
                raise HTTPException(503, 'Generated artifact reservation could not be reconciled.')
            total += token_bytes
        if total > int(item.get('artifact_reserved') or 0):
            raise HTTPException(503, 'Stored artifacts exceed the held reservation; reservation retained.')
        return rpc('review_reconcile_finish', {
            'p_id':review_id, 'p_user':owner, 'p_attempt':identity(item['lease_token']),
            'p_cleanup':identity(item['cleanup_token']), 'p_artifact_bytes':total})

    def reconcile_pending(self, review_id, owner):
        review_id, owner = identity(review_id), identity(owner)
        claim = rpc('review_reconcile_claim', {'p_id':review_id,'p_user':owner})
        if claim:
            self.reconcile_claim(claim)
        fresh = self.get(review_id, owner)
        if fresh['state'] == 'open' and fresh.get('lease_token'):
            raise HTTPException(409, 'A previous generation attempt is being safely reconciled. Retry generation shortly.')
        return fresh

    def download(self, item, kind):
        result=json.loads(item['result']); artifact=result.get('durable_artifact',{})
        token=identity(artifact.get('token'))
        name='output.xlsx' if kind=='download' else 'report.csv'
        path=f"{identity(item['owner'])}/{identity(item['id'])}/{token}/{name}"
        data=storage_request('GET','object/authenticated/'+BUCKET+'/'+quote(path,safe='/'))
        if digest(data)!=artifact.get('output_hash' if kind=='download' else 'report_hash'):
            raise HTTPException(503,'Stored export integrity check failed.')
        return data


def cleanup_reviews(limit=20):
    """Run from the existing maintenance scheduler; leases make deletion resumable."""
    for _ in range(limit):
        item=rpc('review_cleanup_claim',{})
        if not item:break
        base=f"{identity(item['owner'])}/{identity(item['id'])}"
        paths=[base+'/source.xlsx']
        for token in item.get('artifact_tokens',[]):
            token=identity(token)
            paths += [base+'/'+token+'/output.xlsx',base+'/'+token+'/report.csv']
        storage_request('DELETE','object/'+BUCKET,json.dumps({'prefixes':paths}).encode(),content_type='application/json')
        rpc('review_cleanup_finish',{'p_id':item['id'],'p_token':item['cleanup_token']})

    # Reconcile quarantined attempts for reviews that are still active. This
    # accounts any partial upload by token and never deletes an active review.
    repository = SupabaseReviews()
    for _ in range(limit):
        item = rpc('review_reconcile_claim', {'p_id':None,'p_user':None})
        if not item:break
        try:
            repository.reconcile_claim(item)
        except HTTPException:
            logger.warning('Review artifact reservation reconciliation deferred; its reservation remains held.')

    # A late in-flight storage request can finish after a tombstone was cleaned.
    # Periodic reconciliation prevents such objects from becoming permanent orphans.
    for path in rpc('review_orphan_paths',{}) or []:
        if not re.fullmatch(r'[0-9a-f-]{36}/[0-9a-f-]{36}/(?:source\.xlsx|[0-9a-f-]{36}/(?:output\.xlsx|report\.csv))',path):
            raise HTTPException(503,'Invalid orphan cleanup path; deletion refused.')
        storage_request('DELETE','object/'+BUCKET,json.dumps({'prefixes':[path]}).encode(),content_type='application/json')
