"""Conservative monetary aggregation, independent of GST rate classification."""
from copy import copy
from decimal import Decimal, ROUND_HALF_UP, localcontext
import re
import hashlib

from openpyxl.workbook.defined_name import DefinedName
from openpyxl.utils import quote_sheetname
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter, column_index_from_string

FIELDS = {'invoice': 'Invoice Value', 'taxable': 'Taxable Value', 'igst': 'IGST',
          'cgst': 'CGST', 'sgst': 'SGST/UTGST', 'cess': 'Cess'}
CURRENCY = '"₹" #,##0.00;[Red]-"₹" #,##0.00'


def norm(value):
    return re.sub(r'[^a-z0-9]+', ' ', str(value or '').lower()).strip()


def header_kind(value):
    text = norm(value)
    words = set(text.split())
    compact = text.replace(' ', '')
    if compact in {'igst', 'igstamount', 'igstvalue', 'igstrs', 'igstinr'}: return 'igst'
    if compact in {'cgst', 'cgstamount', 'cgstvalue', 'cgstrs', 'cgstinr'}: return 'cgst'
    if compact in {'sgst', 'utgst', 'sgstutgst', 'sgstamount', 'utgstamount'}: return 'sgst'
    acronyms = words & {'igst', 'cgst', 'sgst', 'utgst'}
    if len(acronyms) > 1 and not acronyms <= {'sgst', 'utgst'}:
        return None
    if ('invoice' in words or 'inv' in words) and words & {'value', 'amount', 'amt'}:
        return 'invoice'
    if 'taxable' in words and words & {'value', 'amount', 'amt'}:
        return 'taxable'
    if ('igst' in words or ('integrated' in words and 'tax' in words)) and not words & {'rate', 'percent'}:
        return 'igst'
    if ('cgst' in words or ('central' in words and 'tax' in words)) and not words & {'rate', 'percent'}:
        return 'cgst'
    if (words & {'sgst', 'utgst'} or compact.startswith('sgstutgst') or
            (words & {'state', 'ut', 'union'} and 'tax' in words)) and not words & {'rate', 'percent'}:
        return 'sgst'
    if 'cess' in words and not words & {'rate', 'percent'}:
        return 'cess'
    return None


def header_at(ws, cell):
    """Recognize vertically split labels/units without reading transaction text as a header."""
    key = header_kind(cell.value)
    if key:
        return key
    fragment = norm(cell.value)
    if fragment not in {'value', 'amount', 'amt', 'tax', 'inr', 'rs', 'rupees'} and str(cell.value or '').strip() != '\u20b9':
        return None
    parts = [ws.cell(row, cell.column).value for row in range(max(1, cell.row - 2), cell.row + 1)]
    if not all(value is None or isinstance(value, str) for value in parts):
        return None
    return header_kind(' '.join(str(value or '') for value in parts))


def detect_monetary_columns(ws, last_header_row=40):
    candidates = {key: set() for key in FIELDS}
    for row in ws.iter_rows(max_row=min(ws.max_row, last_header_row)):
        for cell in row:
            key = header_at(ws, cell)
            if key and '%' not in str(cell.value):
                candidates[key].add(cell.column)
    columns = {key: next(iter(cols)) if len(cols) == 1 else None for key, cols in candidates.items()}
    warnings = [f'{FIELDS[key]} column is {"ambiguous" if cols else "missing"}; select a column or review.'
                for key, cols in candidates.items() if len(cols) != 1 and key != 'cess']
    if len(candidates['cess']) > 1:
        warnings.append('Cess column is ambiguous; select a column or review.')
    return {'columns': columns, 'candidates': {k: sorted(v) for k, v in candidates.items()}, 'warnings': warnings}


def marker_name(ws, kind):
    return '_GST_LEDGER_' + kind + '_' + hashlib.sha256(ws.title.encode()).hexdigest()[:16]


def marker_destination(ws, kind):
    name = ws.parent.defined_names.get(marker_name(ws, kind))
    if name is None:
        return None
    try:
        sheet, reference = next(iter(name.destinations))
        return sheet.replace("''", "'"), reference
    except (ValueError, StopIteration, TypeError):
        return None


def generated_row(ws, row):
    destination = marker_destination(ws, 'TOTAL')
    if not destination or destination[0] != ws.title:
        return False
    from openpyxl.utils.cell import coordinate_from_string
    try:
        col, number = coordinate_from_string(destination[1].replace('$', ''))
        return number == row and ws.cell(row, column_index_from_string(col)).value == 'GRAND TOTAL'
    except ValueError:
        return False


def excluded_reason(ws, row, columns):
    if generated_row(ws, row):
        return 'generated_total'
    # Recognize labels, not substrings in descriptions or invoice identifiers.
    for cell in ws[row]:
        if isinstance(cell.value, str) and re.fullmatch(
                r'(?:grand\s*total|sub\s*total|total)(?:\s+(?:amount|value|inr|rs|invoice value|taxable value|igst|cgst|sgst|cess))?', norm(cell.value)):
            return 'existing_total'
    selected = [ws.cell(row, col) for col in columns.values() if col]
    header_matches = sum(header_at(ws, cell) is not None or norm(cell.value) in {
        'invoice', 'taxable', 'integrated', 'central', 'state', 'state ut', 'cess',
        'value', 'amount', 'inr', 'rs', 'rupees'} for cell in selected)
    if header_matches >= 2 and not any(isinstance(cell.value, (int, float, Decimal)) for cell in selected):
        return 'repeated_header'
    if not any(ws.cell(row, col).value not in (None, '') for col in columns.values() if col):
        return 'blank'
    return None


def monetary_value(cell):
    if cell.value is None or cell.value == '':
        return Decimal(0), 'blank'
    if (isinstance(cell.value, bool) or not isinstance(cell.value, (int, float, Decimal))
            or cell.is_date or '%' in cell.number_format or cell.data_type in {'f', 'e'}):
        return None, 'invalid'
    value = Decimal(str(cell.value))
    return (value, 'numeric') if value.is_finite() else (None, 'invalid')


def aggregate(ws, first_data_row, invoice_col, taxable_col, overrides=None):
    if not 2 <= first_data_row <= ws.max_row + 1:
        raise ValueError('First data row must follow the headers and lie within the worksheet.')
    detected = detect_monetary_columns(ws, first_data_row - 1)
    columns = {**detected['columns'], 'invoice': invoice_col, 'taxable': taxable_col}
    for key, col in (overrides or {}).items():
        if key not in {'igst', 'cgst', 'sgst', 'cess'}:
            raise ValueError('Only IGST, CGST, SGST/UTGST and Cess mappings may be overridden.')
        if col is not None and (isinstance(col, bool) or not isinstance(col, int) or not 1 <= col <= ws.max_column):
            raise ValueError('Monetary column selection is outside the worksheet.')
        columns[key] = col
    chosen = [col for col in columns.values() if col is not None]
    if len(set(chosen)) != len(chosen) or any(not 1 <= col <= ws.max_column for col in chosen):
        raise ValueError('Each monetary field must use a different valid source column.')
    for col in chosen:
        for row in range(1, first_data_row):
            value = ws.cell(row, col).value
            text = norm(value)
            if '%' in str(value or '') or set(text.split()) & {'rate', 'percent', 'percentage'}:
                raise ValueError('Rate (%) or percentage columns cannot be monetary columns.')
            if text in {'invoice number', 'invoice no', 'inv no', 'inv number', 'bill no',
                        'bill number', 'document number', 'document no', 'gstin'}:
                raise ValueError('Invoice identifiers cannot be monetary columns.')
    warnings = [f'{FIELDS[key]} column is unavailable; total is not calculated.' for key, col in columns.items()
                if col is None and (key != 'cess' or detected['candidates']['cess'])]
    included, excluded, issues = [], [], []
    sums = {key: Decimal(0) for key in FIELDS}
    blanks = {key: 0 for key in FIELDS}
    invalid = {key: 0 for key in FIELDS}
    with localcontext() as ctx:
        ctx.prec = 50
        for row in range(first_data_row, ws.max_row + 1):
            reason = excluded_reason(ws, row, columns)
            if reason:
                if reason != 'blank':
                    excluded.append({'row': row, 'reason': reason})
                continue
            included.append(row)
            for key, col in columns.items():
                if col is None:
                    continue
                value, state = monetary_value(ws.cell(row, col))
                if state == 'invalid':
                    invalid[key] += 1
                    issues.append({'row': row, 'field': key, 'column': col, 'message': 'Invalid monetary value; excluded from this column total.'})
                else:
                    sums[key] += value
                    blanks[key] += state == 'blank'
        totals = {key: {'label': FIELDS[key], 'source_column': col,
                        'total': str(sums[key].quantize(Decimal('.01'), rounding=ROUND_HALF_UP)) if col else None,
                        'blank_count': blanks[key], 'invalid_count': invalid[key]}
                  for key, col in columns.items()}
    if not included:
        warnings.append('No transaction rows were included; review the worksheet and first data row.')
    if issues:
        warnings.append('Invalid monetary cells were excluded from their column totals. Review the listed cells before filing.')
    return {'worksheet': ws.title, 'columns': totals, 'included_rows': included, 'excluded_rows': excluded,
            'issues': issues, 'warnings': warnings, 'output': None}


def write_totals(wb, ws, totals, shift_column=None):
    """Append only to simple transaction tails; otherwise add a marked summary."""
    def mapped(col):
        return col + 1 if shift_column and col >= shift_column else col
    columns = {key: mapped(item['source_column']) for key, item in totals['columns'].items() if item['source_column']}
    generated = [r for r in range(1, ws.max_row + 1) if generated_row(ws, r)]
    safe = (not ws.protection.sheet and not totals['excluded_rows'] and
            not ws.merged_cells.ranges and totals['included_rows'] and
            max(totals['included_rows']) == ws.max_row and not ws.print_area and not ws.print_title_rows)
    if generated:
        # Update only an app-owned row, never any original grand total.
        target, row = ws, generated[-1]
        label_col = next(c.column for c in ws[row] if c.value == 'GRAND TOTAL')
        if ws.protection.sheet:
            totals['warnings'].append('Existing generated total is protected; workbook totals were not changed.')
            return False
    elif safe:
        target, row = ws, ws.max_row + 1
        label_col = next((c for c in range(1, ws.max_column + 1) if c not in columns.values()), None)
        if label_col is None:
            safe = False
    if not generated and not safe:
        destination = marker_destination(ws, 'SUMMARY')
        target = (wb[destination[0]] if destination and destination[0] in wb.sheetnames
                  and destination[0] != ws.title and destination[1] == '$A$1'
                  and wb[destination[0]]['A1'].value == 'GST Column Totals'
                  and wb[destination[0]]['B2'].value == ws.title else None)
        if target is None:
            if wb.security and wb.security.lockStructure:
                totals['warnings'].append('Workbook structure is protected and a summary sheet is required; totals are available in the API only.')
                return False
            title = 'GST Totals Summary'
            suffix = 1
            while title in wb.sheetnames:
                suffix += 1
                title = f'GST Totals Summary {suffix}'
            target = wb.create_sheet(title)
        if target.protection.sheet:
            totals['warnings'].append('Summary sheet is protected; totals are available in the API only.')
            return False
        target['A1'] = 'GST Column Totals'
        wb.defined_names.add(DefinedName(marker_name(ws, 'SUMMARY'), attr_text=quote_sheetname(target.title) + '!$A$1', hidden=True))
        target['A1'].font = Font(name='Calibri', size=16, bold=True, color='216747')
        target['A4'] = 'Monetary column'
        target['B4'] = 'Total (INR)'
        for cell in target[4]:
            cell.font = Font(bold=True)
            cell.fill = PatternFill('solid', fgColor='E6F1EC')
        target['A2'] = 'Source worksheet'
        target['B2'] = ws.title
        target['B2'].data_type = 's'
        target['A3'] = 'Included transaction rows'
        target['B3'] = len(totals['included_rows'])
        for index, (key, item) in enumerate(totals['columns'].items(), 5):
            target.cell(index, 1, FIELDS[key])
            target.cell(index, 2).value = Decimal(item['total']) if item['total'] is not None else 'Unavailable'
            target.cell(index, 2).number_format = CURRENCY
        target['A12'] = 'Invalid cells excluded'
        target['B12'] = len(totals['issues'])
        target.column_dimensions['A'].width = 30
        target.column_dimensions['B'].width = 24
        totals['output'] = {'worksheet': target.title, 'mode': 'summary_sheet'}
        return True
    target.cell(row, label_col, 'GRAND TOTAL')
    wb.defined_names.add(DefinedName(marker_name(ws, 'TOTAL'), attr_text=quote_sheetname(ws.title) + f'!${get_column_letter(label_col)}${row}', hidden=True))
    for key, col in columns.items():
        cell = target.cell(row, col)
        if row > 1:
            cell._style = copy(target.cell(row - 1, col)._style)
        cell.value = Decimal(totals['columns'][key]['total'])
        cell.number_format = CURRENCY
    for cell in target[row]:
        cell.font = Font(name=cell.font.name or 'Calibri', size=cell.font.sz or 11, bold=True)
        cell.fill = PatternFill('solid', fgColor='E6F1EC')
    totals['output'] = {'worksheet': ws.title, 'mode': 'grand_total_row', 'row': row}
    return True
