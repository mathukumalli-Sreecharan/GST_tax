# Preservation precision investigation and fix

Production clarification: the user subsequently confirmed that source B2B!Q7 is an empty text cell (`value=''`, `data_type='s'`), with Invoice Value at F and Taxable Value at I. The reported production Q7 failure is therefore explained by empty-text serialization normalization, reproduced separately in `EMPTY_TEXT_PRESERVATION_FIX.md`. The numeric precision loss below is a distinct genuine serializer issue found during the initial investigation, not the cause of this production Q7 value.

## Finding

The exact message `Preservation verification failed: original value at B2B!Q7 changed.` was reproduced locally using a synthetic source workbook. The reproduction deliberately places an original 17-digit numeric value in source Q7, with Invoice Value at F and Taxable Value at I. Inserting Rate (%) at J correctly maps original Q7 to R7.

Comparison before the fix:

| Step | Coordinate | Value |
| --- | --- | --- |
| Synthetic original | B2B!Q7 | integer `12345678901234567` |
| OpenPyXL insertion followed by ordinary save/reload | B2B!R7 | float `1.234567890123457e+16`, numerically `12345678901234570` |

This is real serializer precision loss, not a false-positive comparison or an off-by-one column map. OpenPyXL's numeric writer formats numeric values with 16 significant digits. Original XLSX files can contain numeric representations that change under that serialization, including long integers and floating-point values carrying low-order precision. Existing generated tests created all numeric values through the same writer and therefore did not cover values originally written with greater precision by other spreadsheet producers.

The production workbook itself is not available in this workspace. The user has since confirmed that Q7 is empty text, ruling out numeric precision as its cause. The numeric reproduction below remains a separate regression case. No input-specific coordinate, numeric value, worksheet name or column letter is hardcoded in the implementation.

## Implementation

- `workbook_preservation.py`: adds `preserve_numeric_cells`. Before final verification, it carries the exact original numeric `<v>` text into the corresponding existing output cell using the same explicit insertion map. Worksheet XML paths are resolved through workbook relationships by worksheet name, rather than assuming sheet order or fixed file names. This also preserves numeric values in unrelated worksheets.
- `excel_processor.py`: calls numeric preservation after saving and metadata restoration, then reopens the file and runs the existing strict verifier. Any failure still removes the generated output and returns a preservation error.
- `tests/test_numeric_preservation.py`: new regression tests using generated worksheets, randomized column orders/header positions/trailing-column positions, and source numeric XML representations that ordinary OpenPyXL saving actually changes.
- `PRESERVATION_PRECISION_FIX.md`: this report.

`monetary_totals.py` was reviewed but did not require modification for this fix. No Supabase, authentication, notification, approval, migration, frontend or deployment files were changed.

Only the source numeric value element is retained; the fix does not transplant styles, shared-string indexes, formulas, comments or relationship IDs. It does not introduce numeric tolerances, skip trailing columns or disable verification. If the mapped numeric cell is absent, no longer numeric, or contains a formula, the export is refused rather than guessing where to write it. Other value types remain subject to the existing strict semantic comparison.

Intentional changes are retained: original rate cells are not restored when recalculation was explicitly requested, and the monetary cells of a genuinely marked generated total row are allowed to update. Newly inserted rates and newly created total cells have no original numeric source cell to restore. A regression changes an invoice amount, recalculates, and checks that the new rate and new total survive rather than reverting to their old values.

## Verified behavior

- Original nonempty cells are checked at their dynamically mapped output coordinates, including trailing columns.
- Exact source numeric XML is retained for integer and floating-point precision cases, on the processed sheet and unrelated sheets.
- Original styles and hyperlink targets are retained, and hyperlink coordinates move with the inserted column.
- Merged title regions remain preserved under the existing transformation policy.
- All six monetary totals agree with the shared API/website decimal result and remain directly under the appropriate output columns.
- GRAND TOTAL is immediately after the last included transaction row, on the original selected worksheet.
- Reprocessing retains one generated total row and does not reaggregate it.
- GST rate classification rules and explicit recalculation requirements are unchanged.
- Unsupported comment/drawing workbooks fail safely; the existing corrupted-export regression still rejects and removes a damaged export.

## Results

`env/Scripts/python.exe -m pytest -q -rs --tb=short`: **222 passed, 2 skipped**.

The new precision suite contains 20 cases: 18 layout/precision combinations, one monetary precision/recalculation case, and one unsupported-comment/drawing refusal. Existing dynamic preservation, mapping, merged-layout, totals, corruption, API and GST calculation regressions also passed.

The two skipped tests require unavailable external KK MAY regression files and `PRASUNA 2B-1(1).xlsx`. No test depends on those files for the new precision coverage.

`git diff --check`: passed.

## Limits and operational scope

- The user has confirmed the production Q7 empty-text value/type and selected monetary columns. Its normalization fix is documented separately; all other mismatches continue to fail strictly.
- XLSX numeric lexemes are retained exactly; spreadsheet applications still impose their own display/arithmetic precision limits. Precision already lost in an upstream source cannot be reconstructed.
- Formula-containing inputs, unsupported drawings/tables/macros, unsafe column-reference structures, protected selected sheets and conflicting total destinations retain their existing explicit refusal behavior.
- No live accounting data was logged, no production data was accessed, and no commit, push or deployment was performed.
