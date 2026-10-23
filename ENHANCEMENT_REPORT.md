# GST Ledger Studio enhancement report

## Implemented changes

This release extends the current application. It adds six independent monetary totals and authenticated email confirmation actions. Supabase Auth, owner bootstrap, the approval decision/audit transaction, RLS, private file storage, retention, Resend leases/retries and the GST rate engine remain in use. No production records were accessed or changed; no live email, GitHub push or deployment was performed.

### Files created

- `monetary_totals.py`: header detection, strict decimal aggregation, excluded-row/cell review information, safe workbook totals and repeat-processing markers.
- `supabase/migrations/006_email_approval_actions.sql`: service-only applicant lookup and HTML/plain-text confirmation links for newly frozen request payloads.
- `frontend/app/approval-action/page.tsx`: validates action parameters, verifies sign-in and owner access, and retains the confirmation URL through login.
- `frontend/components/ApprovalConfirmation.tsx`: applicant details and explicit, duplicate-resistant approval/rejection confirmation.
- `tests/test_monetary_totals.py`: totals, precision, invalid values, layout, preservation, repeat-processing, API/output agreement and optional PRASUNA fixture tests.
- `frontend/tests/email-actions-database.test.cjs`: actual PostgreSQL migration, HTML escaping, grants, frozen retry and audited conflict tests.
- `frontend/tests/email-actions.test.cjs`: confirmation rendering, GET safety, login continuation, owner authorization, duplicate clicks and conflicts.
- `ENHANCEMENT_REPORT.md`: this report.

### Files modified

- `excel_processor.py`: runs aggregation before inserting Rate (%), excludes non-transaction rows, maps shifted monetary columns, writes totals without weakening formula refusal. Also fixes classification when Invoice Value is physically after Taxable Value and shifts with the inserted rate column.
- `backend/main.py`: additive inspection/processing fields, optional tax-column overrides, shared transaction-row inclusion and monetary issues in verification/CSV messages.
- `backend/approvals.py`: owner-only, read-only GET applicant endpoint; existing POST decision endpoint is reused unchanged.
- `backend/notifications.py`: accepts frozen multipart HTML/plain-text request payloads as well as older text-only payloads. Administrator-only recipient protection stays intact.
- `frontend/components/Workspace.tsx`: tax-column selectors, mapping warnings and GST Column Totals cards with exact Indian rupee display and review details.
- `frontend/lib/api.ts`, `frontend/lib/types.ts`: optional column mappings and additive response types.
- `frontend/tests/browser/harness.jsx`, `frontend/tests/browser/beta.spec.cjs`: browser coverage for totals display and mobile approval/rejection confirmations.
- `tests/test_approvals.py`: owner-only GET safety and multipart notification idempotency regression tests.
- `tests/test_excel_processor.py`, `tests/test_read_only.py`: preserve original source data, rates, styles and protections while allowing the newly requested totals row/summary sheet.
- `APPROVAL_SETUP.md`, `BETA_DEPLOYMENT.md`, `NOTIFICATION_DELIVERY.md`: current migration and workflow references.

Existing uncommitted diagnostics work, including `.env.example` and `tests/test_notification_diagnostics.py`, is retained. Local `.env` and `frontend/.env.local` were not edited. Build cache changes are excluded from this enhancement.

## Excel logic

Detection scans up to 40 header rows for inspection and only rows preceding the selected first data row during aggregation. It supports vertically split header labels and currency-unit rows. It recognizes Invoice Value/Amount, Taxable Value/Amount, IGST/Integrated Tax, CGST/Central Tax, SGST/UTGST/State-UT Tax and Cess, ignoring case, punctuation and spacing. Invoice/Taxable mappings explicitly selected by the user take precedence. Tax mappings can be selected or omitted; duplicate monetary mappings and Rate (%) mappings are rejected. Ambiguous columns are not silently selected; missing/ambiguous fields are warned and unavailable totals are null rather than zero.

Numeric cells are converted through their decimal representation. Negative adjustments are included. Blank monetary cells contribute zero and have separate blank counts. Text, numeric-looking strings, invoice identifiers, booleans, date cells, percentage-formatted values and error cells are excluded from that monetary field, counted as invalid and listed with their original row/column references. Invalid cells do not cause the other valid monetary fields in the same transaction to be discarded. GST classification retains its original business rules: negative invoice/taxable amounts still require rate verification even though they contribute to signed totals.

Headers above the selected first data row, recognizable repeated headers, labeled grand totals/subtotals and the application's generated total row are excluded. Fully blank monetary rows are skipped. Included and excluded row references are returned, and the results table uses the same included rows. Invalid monetary issues are appended to existing verification messages; no existing tax amounts are overwritten. Totals are rounded once, after summing, to two decimal places using ROUND_HALF_UP. The frontend formats the decimal strings with Indian grouping without first converting the amount to a binary floating-point Number.

A simple sheet with a clear transaction tail receives one styled GRAND TOTAL row. Existing total rows, merged layouts, protected selected sheets, print layouts or trailing content cause a separate GST Totals Summary worksheet to be used. Existing user-created sheets with that name are retained; a suffixed name is chosen. Hidden application-specific named ranges identify generated output for repeat processing, including worksheet names containing apostrophes. No comments/drawings or formulas are introduced. Original sheet/cell content remains in place, apart from the existing Rate (%) column insertion policy.

The export uses numeric totals as the safe equivalent to SUM formulas: only explicitly included valid monetary cells contribute, and existing subtotals are never summed again. This also lets the generated workbook be processed again while retaining the existing refusal of all formula-containing input workbooks. The GST Rate (%) field is never aggregated. Totals are snapshots; spreadsheet edits require reprocessing to refresh them.

### Example API response (additive fragment)

Existing `file_id`, `summary`, `rows`, `verification`, `history` and `rate_column` fields remain. A selected sheet with two transactions of 118/100/18 and 59/50/9 plus zero central/state tax and Cess 1/0 returns a structure like:

```json
{
  "column_totals": {
    "worksheet": "B2B",
    "columns": {
      "invoice": {"label": "Invoice Value", "source_column": 2, "total": "177.00", "blank_count": 0, "invalid_count": 0},
      "taxable": {"label": "Taxable Value", "source_column": 3, "total": "150.00", "blank_count": 0, "invalid_count": 0},
      "igst": {"label": "IGST", "source_column": 4, "total": "27.00", "blank_count": 0, "invalid_count": 0},
      "cgst": {"label": "CGST", "source_column": 5, "total": "0.00", "blank_count": 0, "invalid_count": 0},
      "sgst": {"label": "SGST/UTGST", "source_column": 6, "total": "0.00", "blank_count": 0, "invalid_count": 0},
      "cess": {"label": "Cess", "source_column": 7, "total": "1.00", "blank_count": 0, "invalid_count": 0}
    },
    "included_rows": [2, 3],
    "excluded_rows": [],
    "issues": [],
    "warnings": [],
    "output": {"worksheet": "B2B", "mode": "grand_total_row", "row": 4}
  }
}
```

`source_column` always refers to the uploaded workbook, before inserting Rate (%). Optional multipart `monetary_columns` is JSON, for example `{"igst":10,"cgst":11,"sgst":12,"cess":13}`. Invoice/Taxable selection continues to use the existing separate form fields.

### Example downloaded workbook

```text
B2B
  Invoice Number | Invoice Value | Taxable Value | Rate(%) | IGST | CGST | SGST/UTGST | Cess
  INV-001        |        118.00 |        100.00 |      18 |   18 |    0 |          0 |    1
  INV-002        |         59.00 |         50.00 |      18 |    9 |    0 |          0 |    0
  GRAND TOTAL    |        177.00 |        150.00 |         |   27 |    0 |          0 |    1
```

For a complex GSTR-2B layout, original worksheets remain and GST Totals Summary contains source worksheet, included transaction count, the six monetary totals and invalid-cell count. Currency cells have two-decimal INR formats.

## Email workflow

New request emails include mobile-friendly Approve and Reject buttons and the same links in the plain-text alternative. Links contain only applicant UUID and proposed decision, e.g. `/approval-action?user=<UUID>&decision=approved`. Names, emails and HTML attributes are escaped.

Opening a link performs no approval mutation. The existing middleware and confirmation page require sign-in and preserve the intended internal destination. The server page verifies owner authorization; a read-only backend endpoint independently checks the owner and returns current applicant details. An explicit confirmation click calls the existing POST endpoint with `expected_status=pending`. Its existing row lock, expected-status comparison and audit transaction prevent duplicate/conflicting decisions. The client disables duplicate submissions and reloads status after failures. Already approved, rejected or revoked accounts are shown without an email confirmation button; further changes use the normal dashboard. Expired sessions resume the same confirmation after login.

Only `request` outbox events are eligible for delivery. Applicant approval/rejection/revocation emails remain disabled, including with `onboarding@resend.dev`. Migration 006 does not rewrite sent, failed, pending or sending rows. Existing frozen text-only emails continue to retry byte-for-byte; only requests first claimed after this migration receive the new HTML and links. Leases, fencing, backoff, attempt caps, stable idempotency keys and the existing review cutoff remain unchanged.

## Validation

Final local validation:

| Check | Result |
| --- | --- |
| `env/Scripts/python.exe -m pytest -q -rs` | 158 passed, 2 skipped |
| `node --test tests/*.test.cjs` (frontend) | 31 passed |
| `node node_modules/@playwright/test/cli.js test` (frontend) | 12 passed |
| `node node_modules/eslint/bin/eslint.js . --max-warnings 0` (frontend) | Passed |
| `node node_modules/typescript/bin/tsc --noEmit` (frontend) | Passed |
| `node node_modules/next/dist/bin/next build` (frontend) | Passed, including type/lint validation and `/approval-action` route |
| `git diff --check` | Passed |

 Automated email tests use HTTP doubles and PostgreSQL tests use PGlite with emulated Supabase Auth/Storage roles. Browser tests exercise actual components against synthetic HTTP responses; they do not send email or access production data. The actual PRASUNA file and older external regression workbook pairs are unavailable, so those fixture tests are skipped. A synthetic GSTR-2B fixture covers F/I/J/K/L/M, multi-row headers and negative adjustments.

## Migration, environment and deployment

Only one new additive migration is required: `006_email_approval_actions.sql`. Apply it once after existing migrations through 005. It creates a tightly granted read-only function and replaces the claim function while retaining service-only permissions. No owner bootstrap, approval reset or outbox reset is needed.

No new required environment variables or services are introduced. Keep:

```dotenv
EMAIL_FROM=GST Ledger Studio <onboarding@resend.dev>
ADMIN_NOTIFICATION_EMAIL=mathukumalli.sreecharan@gmail.com
APP_BASE_URL=https://YOUR-VERCEL-FRONTEND
```

Keep existing backend-only Resend/Supabase credentials and ADMIN_USER_ID. Retain NEXT_PUBLIC_API_BASE and current Supabase public configuration in Vercel. The local APP_BASE_URL can remain localhost; the deployed one must be the production frontend origin. No credentials or authorization tokens belong in email URLs. Optional diagnostics settings from the earlier investigation remain optional.

Manual release order:

1. Review `git status --short`, `git diff` and this report. Stage only intended source/tests/migration/docs, excluding `.env`, `frontend/.env.local`, generated build/cache files and confidential spreadsheets. Commit/push only when ready; if GitHub is linked to auto-deploy, control those integrations before pushing when a staged rollout is required.
2. Deploy the compatible backend update to Render, including its existing maintenance job if enabled. This accepts both old text-only payloads and future HTML payloads. It does not create new-style messages before migration 006.
3. Deploy the Next.js update to Vercel so `/approval-action` is available. Check the configured production frontend origin and existing Supabase login callback configuration.
4. Apply only unapplied migrations through 006 manually in Supabase. This activates new-email action links after the route and compatible workers exist. Never rerun setup_owner for the already approved administrator.
5. Perform an authorized new-signup acceptance check: verify email, inspect one administrator email, sign in as owner, confirm one decision and inspect the audit result. Opening/previewing the email link must not change approval. Confirm the existing dashboard, Excel processing and My Files still work. Do not reset old notification rows to manufacture a test.

Render Free sleep behavior is unchanged. Database triggers persist new verified requests even while Render sleeps. Delivery waits for web wake-up unless the already-supported independent scheduler is active; the awake worker polls every 30 seconds. No paid service or keep-alive mechanism was added. See NOTIFICATION_DELIVERY.md for existing scheduling and safe HTTP diagnostics.

## Limitations and edge cases

- Header detection and total-label recognition are conservative heuristics. Confirm the first data row and mappings for unusual headers, unlabeled numeric subtotal rows, nested tables or unconventional section layouts. Formula inputs remain refused; no cached values are substituted.
- Native Excel numbers have Excel's precision limits. Decimal aggregation prevents added binary floating-point error in the API; it cannot recover precision lost in the source workbook. Excel output remains native numeric currency cells.
- Numeric-looking text is deliberately excluded rather than silently converted. Missing/ambiguous columns produce null totals and warnings. Invalid cells make totals partial until reviewed.
- If sheet protection and workbook structure protection prevent a safe totals export, protections are retained and API totals include an explicit warning. No security/protection bypass is attempted.
- Generated totals are identified by hidden named ranges. Removing those markers manually prevents automatic reuse, although recognizable GRAND TOTAL rows still remain excluded from aggregation. Existing user totals are never rewritten.
- New action links are added only to newly frozen messages. Previously frozen/sent messages retain their original content and recipients. Resend acceptance is not proof of Gmail inbox delivery.
- Live Supabase, Render, Vercel and Gmail acceptance remains a manual deployment check; no production behavior is claimed from mocked/local tests.
