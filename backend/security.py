"""Resource limits and production configuration checks, outside GST business logic."""
from io import BytesIO
import os
from urllib.parse import urlsplit
from zipfile import BadZipFile, ZipFile
from xml.etree.ElementTree import ParseError

from defusedxml.ElementTree import iterparse
from defusedxml.common import DefusedXmlException
from fastapi import HTTPException
from openpyxl.utils.cell import range_boundaries
from openpyxl.utils.cell import coordinate_from_string, column_index_from_string
from openpyxl.utils.exceptions import CellCoordinatesException
from starlette.responses import JSONResponse


def validate_upload_package(data: bytes):
    # Encrypted/non-ZIP errors retain the existing specific processor messages.
    if not data.startswith(b'PK'):
        return
    try:
        with ZipFile(BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries)>2000 or sum(e.file_size for e in entries)>100*1024*1024 or any(e.file_size>50*1024*1024 for e in entries):
                raise HTTPException(413, "Workbook expands beyond the supported XLSX resource limits (100 MB total, 50 MB per part, 2,000 parts).")
            if len({e.filename for e in entries}) != len(entries):
                raise HTTPException(422, "Workbook contains ambiguous duplicate ZIP parts.")
            for entry in entries:
                if entry.flag_bits & 1:
                    raise HTTPException(422, "Encrypted ZIP workbook contents are not supported.")
                if entry.filename.startswith('xl/worksheets/') and entry.filename.endswith('.xml'):
                    with archive.open(entry) as part:
                        cells=0
                        for _, element in iterparse(part,events=('end',)):
                            tag=element.tag.rsplit('}',1)[-1]
                            if tag=='dimension' and element.get('ref'):
                                first,row,last,end=range_boundaries(element.get('ref'))
                                if last*end>2_000_000:
                                    raise HTTPException(413, "Worksheet dimensions exceed the supported 2,000,000-cell processing area.")
                            if tag=='c':
                                if element.get('r'):
                                    letter,number=coordinate_from_string(element.get('r'))
                                    if column_index_from_string(letter)*number>2_000_000:
                                        raise HTTPException(413, "Worksheet cell coordinates exceed the supported processing area.")
                                cells+=1
                                if cells>2_000_000:
                                    raise HTTPException(413, "Worksheet exceeds the supported cell limit.")
                            element.clear()
    except HTTPException:
        raise
    except (BadZipFile, ParseError, DefusedXmlException, ValueError, TypeError, RuntimeError, CellCoordinatesException):
        raise HTTPException(422, "Invalid or unsafe XLSX package. Upload a readable, unencrypted workbook.") from None


def validate_production_config():
    if os.getenv('APP_ENV')!='production':
        return
    for name in ('SUPABASE_URL','APP_BASE_URL'):
        parsed=urlsplit(os.getenv(name,''))
        if parsed.scheme!='https' or not parsed.netloc or parsed.path.rstrip('/') or parsed.username or parsed.query or parsed.fragment:
            raise RuntimeError(f'{name} must be an HTTPS origin in production.')
    origins=[origin.strip().rstrip('/') for origin in os.getenv('CORS_ORIGINS','').split(',') if origin.strip()]
    if not origins:
        raise RuntimeError('Set explicit production CORS_ORIGINS.')
    for origin in origins:
        parsed=urlsplit(origin)
        if parsed.scheme!='https' or not parsed.netloc or parsed.path or '*' in origin or parsed.username or parsed.query or parsed.fragment:
            raise RuntimeError('CORS_ORIGINS must contain explicit HTTPS origins in production.')


class UploadLimitMiddleware:
    def __init__(self,app,max_bytes=21*1024*1024):
        self.app,self.max_bytes=app,max_bytes

    async def __call__(self,scope,receive,send):
        if scope['type']!='http':
            return await self.app(scope,receive,send)
        headers=dict(scope.get('headers',[]))
        length=headers.get(b'content-length')
        try:
            oversized=length is not None and int(length)>self.max_bytes
        except ValueError:
            oversized=True
        if oversized:
            return await JSONResponse({'detail':'Request exceeds the 20 MB workbook upload limit.'},status_code=413)(scope,receive,send)
        total=0
        async def limited_receive():
            nonlocal total
            message=await receive()
            total+=len(message.get('body',b''))
            if total>self.max_bytes:
                raise HTTPException(413,'Request exceeds the workbook upload limit.')
            return message
        await self.app(scope,limited_receive,send)
