# Dynamic totals and data preservation fix

This Excel-only change supersedes the earlier summary-sheet fallback. Authentication, Supabase settings, approvals, notifications, migrations, billing and deployment configuration were not modified. No commit, push, live email, production mutation or deployment was performed.

## Findings and root causes

- The previous totals writer deliberately diverted merged layouts, existing totals and trailing content to a separate summary sheet. That did not satisfy the new mandatory original-sheet GRAND TOTAL requirement.
- It relied on worksheet dimensions for simple append cases, even though formatted blank rows or footer content can extend beyond transactions. The new row is based on the shared included transaction rows instead.
- Rate insertion already shifted cell objects and column dimensions, but freeze panes, print references and hyperlink cell references were not fully relocated. Looking up a missing taxable-column dimension could also create a default-width override within a grouped column. These reference/formatting risks are fixed.
- Unmerge/remerge can redistribute border styles. Original styled cells are now restored at their mapped coordinates after rebuilding merges.
- The old export check only checked sheet names and the existence of the rate column. It could not prove that original trailing values or styles survived. Exports now undergo semantic comparison against the original workbook after being saved and reopened.
- No supplied workbook demonstrating historical transaction-value loss is available locally. The fixes address inspected transformation risks and add a deliberately corrupted-export test; they do not assert a confirmed cause for an unseen historical file.

## Modified and created files

Modified:

- `monetary_totals.py`: mandatory original-sheet totals, dynamic transaction-end placement, explicit conflicts, footer/ambiguous-boundary checks, repeat-processing checks and borders.
- `excel_processor.py`: dynamic header scanning beyond the old 40-row default, safer rate-column handling, supported reference shifts, preservation validation, original metadata restoration and explicit unsupported-layout refusals.
- `tests/test_excel_processor.py`: merged-title sheets now retain their sheet list and receive original-sheet totals.
- `tests/test_monetary_totals.py`: replaces summary-only expectations with mandatory original-sheet totals; conflicting existing rows must have a blank destination or be refused.
- `tests/test_read_only.py`: protected selected sheets are refused when the mandatory totals row cannot be written without bypassing protection.

Created:

- `workbook_preservation.py`: source-to-export cell verification, metadata/geometry checks, GST classification verification and exact comparison with the shared monetary totals.
- `tests/test_dynamic_totals_preservation.py`: generated workbooks with varied worksheet names, header positions, tax-column permutations, optional monetary columns, trailing columns, merged titles, styles, grouped widths, print references, hyperlinks, notes, conflicts, corruption and repeat processing.
- `DYNAMIC_TOTALS_FIX_REPORT.md`: this report.

No frontend code change is needed. The API still returns the same `column_totals` result consumed by the existing GST Column Totals display. Successful exports always report `output.mode=grand_total_row` on the selected original sheet; no new summary sheet is created or updated.

## Detection and aggregation

Headers are recognized from names and vertically split labels/currency units, with punctuation/case/spacing normalization. Header/rate detection no longer assumes a header lies within the first 40 rows. Monetary aggregation scans the actual header region before the selected first data row. Selected Invoice Value and Taxable Value mappings remain authoritative; optional tax mappings and missing/ambiguous-column warnings are retained.

Each monetary column is summed independently with Decimal arithmetic, with final ROUND_HALF_UP rounding to two places. Negative adjustments are included. Blank cells contribute zero; invalid text, identifiers, dates, percentages and errors remain excluded from that field and listed for verification. Existing subtotal/grand-total rows, repeated headers, generated totals and fully blank monetary rows are excluded. Labeled notes without transaction values are excluded; transaction descriptions starting with Note are retained when invoice/taxable values identify a transaction. Invalid-only content without recognizable transaction identity causes a boundary verification error rather than a guessed export.

The calculation engine, supported 5/12/18/28 rates, tolerances, original negative-value verification rules and overwrite-confirmation mechanism are unchanged.

## GRAND TOTAL placement

1. Use the maximum included transaction row, independent of worksheet dimensions, fixed column letters or trailing formatting.
2. Choose exactly the next physical row.
3. Write each shared result directly under its monetary column, accounting for insertion of Rate (%). Place the GRAND TOTAL label in a non-monetary column; no Rate (%) sum is written.
4. Apply bold text, a top border, a restrained fill and two-decimal INR number formats.
5. Reuse the existing hidden named-range marker when its generated row is exactly at the destination. Generated totals are never classified as transactions or included in aggregation.
6. Refuse with an explicit verification error if the row is occupied, intersects merged cells, is protected, lies beyond the Excel row limit, has conflicting mappings, or the old generated row is no longer in the required position. Existing rows are not automatically shifted: refusing avoids changing row references, notes or layout.

A free spacer immediately after the data can hold the total while original notes, existing subtotals or formatting farther below remain untouched. The total is the last row of the transaction table; preserved footers/formatting can still follow it. If an original footer or grand total occupies the immediate destination, processing returns HTTP 422 rather than overwriting it or substituting a summary sheet.

## Preservation checks

The saved workbook is reopened and compared against the source with only these permitted cell modifications:

- A newly inserted Rate (%) column, or explicitly confirmed recalculation of existing rate cells on included transaction rows.
- Values/styles in the generated GRAND TOTAL row.

All original cells are checked at their dynamically mapped locations, including columns after the new rate column and cells on unrelated sheets. Values, styles, comments and hyperlinks are checked. Original merged ranges are verified after the intended column mapping. Exported row/column dimensions, views, freeze panes, filters, print areas/titles, page settings, protection and workbook properties are checked. The original core document properties are restored because OpenPyXL otherwise updates the modification timestamp during save.

Every exported monetary total is compared with the exact decimal string returned to the website. If Excel serialization loses required precision, the output is rejected instead of silently disagreeing. New/recalculated rate values are independently compared with the existing GST engine. Failed export validation deletes the generated output. A test that deliberately corrupts a trailing source value confirms this rejection path.

## Validation results

- Full Python suite: **202 passed, 2 skipped** (`env/Scripts/python.exe -m pytest -q -rs --tb=short`).
- Generated preservation/placement tests cover twelve deterministic layout permutations plus targeted edge cases, with no dependency on an external sample workbook.
- Existing Excel upload/mapping/results/download browser test: **1 passed** (`node node_modules/@playwright/test/cli.js test --grep 'Excel upload'`).
- `git diff --check`: passed.
- Skips: unavailable older KK MAY regression workbook pair and unavailable `PRASUNA 2B-1(1).xlsx`. Synthetic fixtures remain fully exercised.

## Remaining limits

- Formula-containing inputs remain refused under the existing safety policy. No formulas are replaced with cached values. Macros, drawings, pivots, tables and other previously unsupported package features remain refused.
- Inserting a column into a selected sheet containing data validation, conditional formatting or named-reference dependencies is refused explicitly when those references cannot safely be relocated. Workbooks with an existing Rate (%) column can retain these supported structures without insertion.
- Protected selected sheets now fail explicitly because a mandatory original-sheet total cannot be added without bypassing protection. Workbook structure protection alone does not prevent adding a row to an unprotected existing worksheet.
- Unlabeled numeric subtotals or unusual mixed tables cannot always be distinguished from transactions automatically. Review the first data row, mappings and returned included/excluded row references. Known ambiguous boundaries are refused; no general inference of arbitrary accounting semantics is claimed.
- Existing user total rows and legacy summary sheets are preserved rather than rewritten. The new generated total is authoritative for the processed transaction table.
- Occupied destinations require the user to prepare a blank row in an authorized source copy before retrying. There is no automatic row shifting.
- Static numeric totals remain snapshots. Edit the workbook and reprocess it to refresh them. Removing or changing the application's named-range marker can cause an explicit conflict on repeat processing instead of automatic reuse.
