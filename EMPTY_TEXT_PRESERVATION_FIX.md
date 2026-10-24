# Empty text preservation verification fix

## Confirmed production cause

The user checked the failing source workbook and confirmed B2B!Q7 has `value=''`, `data_type='s'`. Invoice Value is F, Taxable Value is I, and inserting Rate (%) at J correctly maps the original Q7 to output R7.

The same behavior is reproduced with generated workbooks and explicit XLSX empty-text XML: OpenPyXL loads `<is><t/></is>` as an empty Python string of type `s`, but serializes it to a blank inline-string cell, which reloads with `value=None`. The string remains empty during column insertion and becomes None during save/reload. The verifier's direct `'' != None` comparison caused the reported production rejection. This is harmless empty-text normalization, not loss of a nonempty source value or incorrect shifting. No sample-specific coordinate, title or value is hardcoded in the fix.

The earlier numeric precision reproduction identified a separate genuine serializer loss. Its preservation fix and tests are retained, but it is not the cause of the now-confirmed empty-text Q7 error.

## Narrow change

`workbook_preservation.py` accepts an unequal value comparison only if all are true:

- The original cell is type `s` and its value is exactly `''`.
- The exported value is exactly `None`.
- The exported cell has a blank-compatible type (`n`, `s` or `inlineStr`), not a formula or error type.

This is one-way and does not strip or normalize whitespace. Space-only strings, tabs, nonempty strings, numeric-looking strings, numbers, dates, errors and formulas receive no exception. The original source-to-output mapping is unchanged, and all original trailing columns are still checked. The exception applies only to the value comparison; style, comment, hyperlink and metadata checks still run independently. Numeric XML preservation and exact numeric/monetary comparisons remain enabled.

GST classification and six-column totals, original-worksheet GRAND TOTAL placement, repeat-processing markers and unsupported-structure refusal are unchanged. No source workbook content is modified to implement this exception.

## Files changed in this follow-up

- `workbook_preservation.py`: narrowly scoped empty-text normalization predicate used only when a source/output value comparison differs.
- `tests/test_empty_text_preservation.py`: generated-layout round trips, whitelist/negative predicate tests, real nonempty-text loss rejection and empty-text style-loss rejection.
- `PRESERVATION_PRECISION_FIX.md`: corrects the earlier production attribution after the user's clarification.
- `EMPTY_TEXT_PRESERVATION_FIX.md`: this report.

Earlier pending numeric-preservation changes are retained. No Supabase, authentication, notifications, approvals, database migrations or deployment settings changed.

## Validation

Full backend regression suite: **242 passed, 2 skipped** (`env/Scripts/python.exe -m pytest -q -rs --tb=short`).

The 20 new cases cover six generated layouts, twelve positive/negative normalization predicates, one deliberate loss of nonempty text and one deliberate loss of formatting on an empty-text cell. Existing numerical precision, mapped trailing-column preservation, corruption rejection, all six totals, rate classification, merged formatting and repeated-processing tests also pass.

The two skipped tests require unavailable external KK MAY and PRASUNA workbook fixtures. The new tests do not depend on them. `git diff --check` passes.

No commit, push, live email, production data change or deployment was performed. The user's inspected value/type plus the generated XML reproduction establish this normalization cause; the production workbook itself was not accessed locally.
