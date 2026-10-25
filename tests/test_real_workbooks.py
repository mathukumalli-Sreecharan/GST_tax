"""Private local acceptance only. Never embed customer cell data in fixtures/logs."""
from collections import Counter
from hashlib import sha256
from pathlib import Path
import re

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook
from backend.main import app
from backend.approvals import require_approved_user
from excel_processor import detect_columns


def test_available_real_workbook_detection_and_pending_user_gate():
    candidates=sorted(Path('.').glob('*.xlsx'))+sorted(Path('tests/fixtures').glob('**/*.xlsx'))
    if not candidates:pytest.skip('No real local workbook; acceptance pending.')
    app.dependency_overrides[require_approved_user]=lambda:'real-acceptance-owner'
    try:
        client=TestClient(app)
        for path in candidates:
            raw=path.read_bytes();before=sha256(raw).digest();wb=load_workbook(path)
            for ws in wb:
                detected=detect_columns(ws)
                if not detected:continue
                first=max(detected['invoice_header_row'],detected['taxable_header_row'])+1
                response=client.post('/api/excel/process',files={'file':('private-real.xlsx',raw)},data={
                    'worksheet':ws.title,'first_data_row':first,'invoice_col':detected['invoice_col'],'taxable_col':detected['taxable_col']})
                assert response.status_code==200
                review=response.json();identities=review['transaction_columns'] if 'transaction_columns' in review else None
                assert identities is not None
                # Independent evidence: valid supplier GSTIN and nonempty invoice ID.
                expected=[]
                for row in range(first,ws.max_row+1):
                    gstin=ws.cell(row,identities['supplier_gstin']).value
                    invoice=ws.cell(row,identities['invoice_number']).value
                    if invoice is not None and re.fullmatch(r'[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]',str(gstin or '')):
                        expected.append(row)
                assert [item['excel_row'] for item in review['rows']]==expected
                assert len(expected)==62
                assert Counter(item['status'] for item in review['rows'])=={'MATCHED':58,'REVIEW_REQUIRED':2,'UNRESOLVED':2}
                assert {item['excel_row'] for item in review['rows'] if item['status']!='MATCHED'}=={8,20,45,59}
                assert review['decisions']=={} and review['progress']['remaining']==4
                assert client.post('/api/excel/reviews/'+review['review_id']+'/generate').status_code==409
                assert 'file_id' not in review
                # Historical cell is observed in source; no unverified real export.
                assert ws['Q7'].value=='' and ws['Q7'].data_type=='s'
            wb.close()
            assert sha256(path.read_bytes()).digest()==before
    finally:app.dependency_overrides.clear()
