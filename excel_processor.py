"""Workbook detection and conservative in-place-structure Excel processing."""
from copy import copy
from decimal import Decimal
from pathlib import Path
from shutil import copyfile
from zipfile import ZipFile
import re
import warnings

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter
from openpyxl.utils.cell import range_boundaries

from gst_calculator import calculate_rate


class PreservationError(ValueError):
    """Raised when OpenPyXL could alter unsupported workbook features."""


def _norm(value):
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def detect_columns(ws, scan_rows=40):
    """Find likely header cells anywhere near the top, including multirow headers."""
    candidates = {"invoice": [], "taxable": []}
    for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, scan_rows)):
        for cell in row:
            text = _norm(cell.value)
            if "invoice" in text and "value" in text:
                candidates["invoice"].append((cell.row, cell.column, text))
            if "taxable" in text and "value" in text:
                candidates["taxable"].append((cell.row, cell.column, text))
    def choose(items, kind):
        if not items:
            return None
        # Prefer a specific invoice value header; then earliest row and leftmost position.
        return sorted(items, key=lambda x: (0 if kind == "invoice" and "invoice value" in x[2] else 1,
                                             x[0], x[1]))[0]
    inv, tax = choose(candidates["invoice"], "invoice"), choose(candidates["taxable"], "taxable")
    if inv is None or tax is None or inv[1] == tax[1]:
        return None
    return {"invoice_col": inv[1], "invoice_header_row": inv[0],
            "taxable_col": tax[1], "taxable_header_row": tax[0]}


def detect_rate_column(ws, scan_rows=40):
    """Return the existing Rate(%) header location, if any."""
    for row in ws.iter_rows(min_row=1, max_row=min(ws.max_row, scan_rows)):
        for cell in row:
            if _norm(cell.value) in {"rate", "rate percent"}:
                return cell.column, cell.row
    return None


def _cell_header(ws, col, header_row):
    # Consolidate a two-row header (for example Invoice Details / Invoice Value).
    parts = []
    for row in range(max(1, header_row - 1), header_row + 1):
        value = ws.cell(row, col).value
        if value is not None and str(value).strip():
            parts.append(str(value).strip())
    return " / ".join(dict.fromkeys(parts)) or f"Column {get_column_letter(col)}"


def _assert_supported(path, wb, ws):
    with ZipFile(path) as archive:
        names = archive.namelist()
        risky = [n for n in names if any(token in n.lower() for token in
                 ("vbaproject", "externallinks/", "pivotcache/", "slicer", "customxml/", "activex/", "embeddings/"))]
        if risky or any(n.startswith("xl/drawings/") for n in names):
            raise PreservationError("This workbook contains macros, external links, pivots, drawings, embedded objects, or custom XML that OpenPyXL cannot guarantee to preserve. No output was generated.")
    if getattr(wb, "vba_archive", None):
        raise PreservationError("Macro-enabled workbooks are not supported for guaranteed preservation.")
    if any(getattr(sheet, "tables", {}) for sheet in wb.worksheets):
        raise PreservationError("Workbooks with Excel tables are not supported for guaranteed preservation.")
    if any(cell.data_type == "f" for sheet in wb.worksheets for row in sheet.iter_rows() for cell in row):
        raise PreservationError("This workbook contains formulas. OpenPyXL cannot safely update all formula references for an inserted column, so no output was generated.")
    if any(sheet.sheet_view.showGridLines is not None for sheet in wb.worksheets):
        pass


def process_workbook(source, destination, sheet_name, invoice_col, taxable_col, header_row,
                     invoice_header_row=None, taxable_header_row=None,
                     existing_rate_col=None, recalculate_existing=False):
    """Insert Rate(%) immediately after taxable column; return summary and flagged rows."""
    source, destination = Path(source), Path(destination)
    if source.resolve() == destination.resolve():
        raise ValueError("The output file must not overwrite the uploaded workbook.")
    if invoice_col == taxable_col:
        raise ValueError("Invoice Value and Taxable Value must be different columns.")
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        wb = load_workbook(source, data_only=False, keep_links=True)
    if caught:
        raise PreservationError("OpenPyXL reported unsupported workbook content: " + "; ".join(str(w.message) for w in caught))
    if sheet_name not in wb.sheetnames:
        raise ValueError("Selected worksheet was not found.")
    ws = wb[sheet_name]
    _assert_supported(source, wb, ws)
    invoice_header_row = invoice_header_row or header_row
    taxable_header_row = taxable_header_row or header_row
    detected_rate = detect_rate_column(ws)
    existing_rate_col = existing_rate_col or (detected_rate[0] if detected_rate else None)
    rate_col = existing_rate_col or (taxable_col + 1)
    rate_letter = get_column_letter(rate_col)
    if not existing_rate_col:
        # OpenPyXL does not shift merged ranges when inserting columns. Rebuild them
        # explicitly so the surrounding title/layout remains intact.
        merged = list(ws.merged_cells.ranges)
        column_dimensions = [copy(dimension) for dimension in ws.column_dimensions.values()]
        filter_ref = ws.auto_filter.ref
        for merged_range in merged:
            ws.unmerge_cells(str(merged_range))
        ws.insert_cols(rate_col, 1)
        # insert_cols leaves column dimension keys and filter ranges at their old
        # addresses. Shift them explicitly so widths and filters stay with columns.
        ws.column_dimensions.clear()
        for dimension in column_dimensions:
            first, last = dimension.min, dimension.max
            if first >= rate_col:
                first += 1
                last += 1
            elif last >= rate_col:
                last += 1
            dimension.min, dimension.max = first, last
            dimension.index = get_column_letter(first)
            ws.column_dimensions[dimension.index] = dimension
        if filter_ref:
            shifted_ranges = []
            for area in filter_ref.split():
                min_col, min_row, max_col, max_row = range_boundaries(area)
                if min_col >= rate_col:
                    min_col += 1
                    max_col += 1
                elif max_col >= rate_col - 1:
                    max_col += 1
                shifted_ranges.append(f"{get_column_letter(min_col)}{min_row}:{get_column_letter(max_col)}{max_row}")
            ws.auto_filter.ref = " ".join(shifted_ranges)
        for merged_range in merged:
            min_col, min_row, max_col, max_row = merged_range.bounds
            if min_col >= rate_col:
                min_col += 1
                max_col += 1
            elif max_col >= rate_col:
                max_col += 1
            ws.merge_cells(start_row=min_row, start_column=min_col, end_row=max_row, end_column=max_col)
        ws.cell(taxable_header_row, rate_col).value = "Rate(%)"
        source_style = ws.cell(taxable_header_row, taxable_col)
        target = ws.cell(taxable_header_row, rate_col)
        if source_style.has_style:
            target._style = copy(source_style._style)
        if source_style.number_format:
            target.number_format = source_style.number_format
        # Match the new field's width to the taxable value column.
        old_letter = get_column_letter(taxable_col)
        new_dimension = ws.column_dimensions[rate_letter]
        if ws.column_dimensions[old_letter].width is not None:
            new_dimension.width = ws.column_dimensions[old_letter].width
    summary = {5: 0, 12: 0, 18: 0, 28: 0, "unmatched": 0}
    flagged = []
    inv_header = _cell_header(ws, invoice_col, invoice_header_row)
    tax_header = _cell_header(ws, taxable_col, taxable_header_row)
    # Keep original physical row numbering and blank rows; process each row independently.
    for row in range(max(invoice_header_row, taxable_header_row) + 1, ws.max_row + 1):
        result = calculate_rate(ws.cell(row, invoice_col).value, ws.cell(row, taxable_col).value)
        if not existing_rate_col or recalculate_existing:
            ws.cell(row, rate_col).value = result.rate
        if result.rate is None:
            summary["unmatched"] += 1
        else:
            summary[result.rate] += 1
        if result.flagged:
            flagged.append({"row": row, "invoice_letter": get_column_letter(invoice_col), "invoice_col": invoice_col,
                            "invoice_header": inv_header, "taxable_letter": get_column_letter(taxable_col),
                            "taxable_col": taxable_col, "taxable_header": tax_header,
                            "rate_letter": rate_letter, "rate_col": rate_col,
                            "difference": str(result.difference) if result.difference is not None else "",
                            "rate": result.rate, "message": result.message})
    try:
        if existing_rate_col and not recalculate_existing:
            # Keeping existing rates must not alter workbook package content.
            copyfile(source, destination)
        else:
            wb.save(destination)
        # Reopen the produced file to ensure its package and workbook structure are valid.
        check = load_workbook(destination, read_only=False, data_only=False)
        if check.sheetnames != wb.sheetnames or rate_col > check[sheet_name].max_column:
            raise PreservationError("Export validation failed; output was removed.")
        check.close()
    except Exception:
        if destination.exists():
            destination.unlink()
        raise
    finally:
        wb.close()
    return {"summary": summary, "flagged": flagged, "rate_col": rate_col,
            "rate_letter": rate_letter, "invoice_header": inv_header, "taxable_header": tax_header}
