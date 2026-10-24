"""Reproduce real serializer precision loss, then verify exact source retention."""
from io import BytesIO
from decimal import Decimal
import random
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import pytest
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font
from openpyxl.utils import get_column_letter
from openpyxl.comments import Comment

from excel_processor import process_workbook, PreservationError
from monetary_totals import generated_row

NS='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'


def raw_values(data, updates):
    out=BytesIO()
    with ZipFile(BytesIO(data)) as original,ZipFile(out,'w') as archive:
        for item in original.infolist():
            content=original.read(item.filename)
            if item.filename in updates:
                root=ET.fromstring(content)
                for cell in root.iter(NS+'c'):
                    if cell.get('r') in updates[item.filename]:
                        cell.find(NS+'v').text=updates[item.filename][cell.get('r')]
                content=ET.tostring(root,encoding='utf-8')
            archive.writestr(item,content)
    return out.getvalue()


def numeric_fixture(seed, lexeme):
    rng=random.Random(seed)
    wb=Workbook();ws=wb.active;ws.title=f'Ledger {seed}'
    header=rng.randint(2,12)
    fields=['invoice','taxable','igst','cgst','sgst','cess'];rng.shuffle(fields)
    columns={field:index for index,field in enumerate(fields,2)}
    labels={'invoice':'Invoice Value','taxable':'Taxable Value','igst':'Integrated Tax',
            'cgst':'Central Tax','sgst':'State/UT Tax','cess':'Cess'}
    ws.cell(header,1,'Invoice Number')
    for field,col in columns.items():ws.cell(header,col,labels[field])
    row=header+1
    ws.cell(row,1,'INV-SYNTHETIC')
    for field,col in columns.items():ws.cell(row,col,118 if field=='invoice' else 100 if field=='taxable' else 18 if field=='igst' else 0)
    tail=max(columns.values())+rng.randint(2,10)
    ws.cell(header,tail,'Original numeric reference')
    cell=ws.cell(row,tail,1);cell.font=Font(name='Arial',bold=True,color='123456');cell.number_format='0.00000000000000000'
    cell.hyperlink='https://example.com/reference'
    ws.merge_cells(start_row=1,start_column=1,end_row=1,end_column=tail)
    other=wb.create_sheet('Unrelated');other.cell(row,tail,1)
    stream=BytesIO();wb.save(stream)
    replacements={'xl/worksheets/sheet1.xml':{cell.coordinate:lexeme},
                  'xl/worksheets/sheet2.xml':{other.cell(row,tail).coordinate:lexeme}}
    return raw_values(stream.getvalue(),replacements),ws.title,header,columns,row,tail


@pytest.mark.parametrize('lexeme',['12345678901234567','0.30000000000000004','123.45678901234567'])
@pytest.mark.parametrize('seed',range(6))
def test_precision_loss_is_real_and_mapped_source_numbers_are_retained(tmp_path,seed,lexeme):
    data,title,header,cols,row,tail=numeric_fixture(seed,lexeme)
    inserted=cols['taxable']+1
    before=load_workbook(BytesIO(data))
    old=before[title].cell(row,tail)
    # Prove ordinary insertion + serialization actually changes this original value.
    uncorrected=load_workbook(BytesIO(data));uncorrected[title].insert_cols(inserted)
    stream=BytesIO();uncorrected.save(stream)
    reread=load_workbook(BytesIO(stream.getvalue()))
    assert reread[title].cell(row,tail+1).value!=old.value
    output=tmp_path/'preserved.xlsx'
    result=process_workbook(data,output,title,cols['invoice'],cols['taxable'],header)
    after=load_workbook(output)
    new=after[title].cell(row,tail+1)
    assert new.value==old.value
    assert new._style==old._style
    assert new.hyperlink.target==old.hyperlink.target
    assert new.hyperlink.ref==new.coordinate
    assert after['Unrelated'].cell(row,tail).value==before['Unrelated'].cell(row,tail).value
    for source_row in before[title]:
        for cell in source_row:
            assert after[title].cell(cell.row,cell.column+(cell.column>=inserted)).value==cell.value
    total_row=max(result['column_totals']['included_rows'])+1
    assert result['column_totals']['output']['row']==total_row
    for field,col in cols.items():
        assert Decimal(str(after[title].cell(total_row,col+(col>=inserted)).value))==Decimal(result['column_totals']['columns'][field]['total'])
    with ZipFile(output) as archive:
        root=ET.fromstring(archive.read('xl/worksheets/sheet1.xml'))
        target=next(cell for cell in root.iter(NS+'c') if cell.get('r')==new.coordinate)
        assert target.find(NS+'v').text==lexeme
    repeated=tmp_path/'repeated.xlsx'
    process_workbook(output,repeated,title,cols['invoice']+(cols['invoice']>=inserted),cols['taxable'],header)
    replay=load_workbook(repeated)
    assert replay[title].cell(row,tail+1).value==old.value
    assert sum(generated_row(replay[title],r) for r in range(1,replay[title].max_row+1))==1
    for workbook in (before,uncorrected,reread,after,replay):workbook.close()


def test_precise_monetary_cells_are_retained_without_reverting_generated_totals(tmp_path):
    data,title,header,cols,row,tail=numeric_fixture(51,'12345678901234567')
    updates={f'{get_column_letter(cols[field])}{row}':value for field,value in {
        'invoice':'118.00000000000001','taxable':'100.00000000000001','igst':'18.000000000000004'}.items()}
    data=raw_values(data,{'xl/worksheets/sheet1.xml':updates})
    first=tmp_path/'first.xlsx'
    result=process_workbook(data,first,title,cols['invoice'],cols['taxable'],header)
    assert result['column_totals']['columns']['invoice']['total']=='118.00'
    assert result['column_totals']['columns']['taxable']['total']=='100.00'
    assert result['column_totals']['columns']['igst']['total']=='18.00'
    inserted=cols['taxable']+1
    wb=load_workbook(first)
    wb[title].cell(row,cols['invoice']+(cols['invoice']>=inserted),128)
    changed=BytesIO();wb.save(changed)
    second=tmp_path/'second.xlsx'
    replay=process_workbook(changed.getvalue(),second,title,cols['invoice']+(cols['invoice']>=inserted),cols['taxable'],header,
                            recalculate_existing=True)
    after=load_workbook(second)
    assert after[title].cell(row,inserted).value==28
    assert after[title].cell(replay['column_totals']['output']['row'],cols['invoice']+(cols['invoice']>=inserted)).value==128
    wb.close();after.close()


def test_unsupported_comment_drawing_fails_without_damaged_output(tmp_path):
    data,title,header,cols,_,_=numeric_fixture(52,'12345678901234567')
    wb=load_workbook(BytesIO(data));wb[title].cell(header+1,1).comment=Comment('Original comment','Owner')
    stream=BytesIO();wb.save(stream)
    output=tmp_path/'unsupported.xlsx'
    with pytest.raises(PreservationError,match='drawings'):
        process_workbook(stream.getvalue(),output,title,cols['invoice'],cols['taxable'],header)
    assert not output.exists()
