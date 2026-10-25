"""Explicit row transformations for financially confirmed split transactions."""
from copy import copy
from bisect import bisect_left
from decimal import Decimal, ROUND_HALF_UP, localcontext
from openpyxl.cell.cell import MergedCell
from openpyxl.utils import get_column_letter, quote_sheetname
from openpyxl.worksheet.cell_range import CellRange
from openpyxl.worksheet.print_settings import PrintArea
from monetary_totals import marker_name, monetary_value


class RowMapping:
    """Prefix offsets make repeated source-to-output lookup logarithmic."""
    def __init__(self, splits):
        self.splits = splits
        self.rows = sorted(splits)
        self.offsets = [0]
        for row in self.rows:
            self.offsets.append(self.offsets[-1] + len(splits[row]) - 1)

    def __call__(self, row):
        first = row + self.offsets[bisect_left(self.rows, row)]
        return list(range(first, first + len(self.splits.get(row, [None]))))


def transform_rows(wb, ws, splits, totals, rate_col, inserted_col, identities):
    """Copy each source row once or N times. Refuse references we cannot safely move."""
    if not splits:
        return
    row_mapping = RowMapping(splits)
    if not set(splits) <= set(totals['included_rows']):
        raise ValueError('Only detected transaction rows may be replaced.')
    if ws.protection.sheet:
        raise ValueError('Protected worksheets cannot be split.')
    if ws.data_validations.count or ws.conditional_formatting or ws.row_breaks.brk or ws.col_breaks.brk:
        raise ValueError('Row splits cannot safely transform validation, conditional formatting or page breaks.')
    if ws.defined_names or any(not name.name.startswith('_GST_LEDGER_TOTAL_') for name in wb.defined_names.values()):
        raise ValueError('Row splits cannot safely transform custom named references.')
    if any(cell.hyperlink and (cell.hyperlink.location or str(cell.hyperlink.target or '').startswith('#'))
           for sheet in wb for cell in sheet._cells.values()):
        raise ValueError('Row splits cannot safely transform internal hyperlink references.')
    merges = list(ws.merged_cells.ranges)
    if any(area.min_row <= row <= area.max_row for area in merges for row in splits):
        raise ValueError('A split transaction intersects merged cells. Unmerge an authorized copy before splitting.')
    if ws.max_row + sum(len(parts)-1 for parts in splits.values()) > 1048576:
        raise ValueError('Replacement rows exceed the Excel worksheet row limit.')
    columns = {key: value['source_column'] + bool(inserted_col and value['source_column'] >= inserted_col)
               for key, value in totals['columns'].items() if value['source_column']}
    # A trailing numeric field is not necessarily invoice metadata. Refuse to
    # multiply unmapped amounts rather than guessing that they can be duplicated.
    shared_cols = {col + bool(inserted_col and col >= inserted_col) for col in identities.values() if col}
    for row in splits:
        for cell in ws[row]:
            if cell.column not in {*columns.values(), *shared_cols, rate_col} and isinstance(cell.value, (int, float, Decimal)) and not cell.is_date:
                raise ValueError('A split row contains an unmapped numeric field. Map financial columns or convert authorized shared identifiers to text before splitting.')
    def shift_range(ref):
        area = CellRange(ref)
        area.min_row = row_mapping(area.min_row)[0]
        area.max_row = row_mapping(area.max_row)[-1]
        return str(area)
    saved = [(cell.row, cell.column, copy(cell)) for cell in ws._cells.values() if not isinstance(cell, MergedCell)]
    dimensions = {row: copy(dim) for row, dim in ws.row_dimensions.items()}
    for area in merges:
        ws.unmerge_cells(str(area))
    ws._cells.clear()
    ws.row_dimensions.clear()
    for old_row, col, original in saved:
        for row in row_mapping(old_row):
            cell = copy(original)
            cell.row = row
            cell._style = copy(original._style)
            if original.hyperlink:
                cell._hyperlink = copy(original.hyperlink); cell.hyperlink.ref = cell.coordinate
            if original.comment:
                cell._comment = None
                cell.comment = copy(original.comment)
            ws._cells[row, col] = cell
    for old_row, dimension in dimensions.items():
        for row in row_mapping(old_row):
            dim = copy(dimension); dim.index = row
            ws.row_dimensions[row] = dim
    for area in merges:
        ws.merge_cells(shift_range(str(area)))
    if ws.auto_filter.ref:
        ws.auto_filter.ref = shift_range(ws.auto_filter.ref)
    if ws.auto_filter.sortState:
        raise ValueError('Row splits cannot safely transform an active worksheet sort state.')
    if ws.print_area:
        ws.print_area = [shift_range(str(area)) for area in PrintArea.from_string(ws.print_area).ranges]
    if ws.print_title_rows:
        first, last = [int(value.replace('$','')) for value in ws.print_title_rows.split(':')]
        if last >= min(splits):
            raise ValueError('Print-title rows intersect transaction data; row split is unsafe.')
    if ws.freeze_panes:
        cell = ws[ws.freeze_panes]
        shifted = row_mapping(cell.row)[0]
        ws.sheet_view.pane.topLeftCell = f'{get_column_letter(cell.column)}{shifted}'
        ws.sheet_view.pane.ySplit = shifted - 1
    for old_row, parts in splits.items():
        for row, part in zip(row_mapping(old_row), parts):
            for key, col in columns.items():
                ws.cell(row, col, Decimal(part[key]))
            ws.cell(row, rate_col, Decimal(part['rate']))
    old_total = totals['output']['row']
    new_total = row_mapping(old_total)[0]
    name = wb.defined_names[marker_name(ws, 'TOTAL')]
    _, ref = next(name.destinations)
    from openpyxl.utils.cell import coordinate_from_string
    letter, _ = coordinate_from_string(ref.replace('$',''))
    name.attr_text = quote_sheetname(ws.title) + f'!${letter}${new_total}'
    totals['output']['row'] = new_total
    totals['source_to_output_rows'] = {str(row): row_mapping(row) for row in totals['included_rows']}
    totals['output_rows'] = [new for row in totals['included_rows'] for new in row_mapping(row)]
    # Rebuild totals from original aggregate plus only the authorized replacements.
    for key, field in totals['columns'].items():
        if field['source_column'] is None:
            continue
        with localcontext() as context:
            context.prec = 50
            total = sum((monetary_value(ws.cell(row, columns[key]))[0] or Decimal(0)) for row in totals['output_rows'])
            quantized = total.quantize(Decimal('.01'), rounding=ROUND_HALF_UP)
        field['original_total'] = field['total']
        field['total'] = str(quantized)
        field['unrounded_total'] = str(total)
        field['rounding_adjustment'] = str(quantized-total)
        field['verified_adjustment'] = str(quantized-Decimal(field['original_total']))
        if quantized!=total:
            warning=field['label']+' uses HALF_UP currency rounding; adjustment '+field['rounding_adjustment']+'.'
            if warning not in totals['warnings']:totals['warnings'].append(warning)
        ws.cell(new_total, columns[key], quantized)
