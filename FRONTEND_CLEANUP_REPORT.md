# Frontend cleanup and UTF-8 audit

## Changes

The Settings page now shows only Calculation Policy. The Workbook Preservation panel and its implementation details are removed from the user interface; all backend preservation checks and restrictions remain unchanged.

Calculation Policy retains the current engine values: 5%, 12%, 18% and 28%; automatic match below ₹1; verification from ₹1 to less than ₹50; unmatched at ₹50 or greater. Corrupted rupee symbols, em dashes, ellipses and middle-dot separators were corrected in source strings. No number formatting or calculation functions were changed.

The header and sidebar FastAPI badges, upload helper line, service-description paragraph, technical processing/loading text and internal arithmetic description were removed or replaced with short business-facing copy. The drop zone, upload icon, Browse files button, XLSX/20 MB validation and all four workflow steps remain.

Other source-copy fixes: the authentication busy label now reads “Please wait…”; the My Files fallback reads “File deletion is pending.”; the missing-configuration response uses a normal unavailable message with the same HTTP 503 and configuration guard. Authentication, cookie, redirect and authorization logic were not altered.

## Files

Modified:

- `frontend/components/Workspace.tsx`
- `frontend/components/AuthForm.tsx` (busy label only)
- `frontend/components/MyFiles.tsx` (fallback label only)
- `frontend/middleware.ts` (503 message only)

Created:

- `frontend/tests/ui-copy.test.cjs`: UTF-8 decoding/source-copy checks, corruption/superscript detection, terminology checks and policy/workflow regression assertions.
- `frontend/tests/browser/ui-copy.spec.cjs`: desktop/mobile Settings and upload checks, all four workspace pages, screenshots, horizontal-overflow checks and unchanged filename/cell display.
- `FRONTEND_CLEANUP_REPORT.md`: this report.

## Audit scope and evidence

All frontend application, component, library and middleware source text was scanned. Existing legitimate Unicode typography in authentication, approval, My Files and loading pages was retained. No CSS hiding, runtime mojibake replacement or conversion of uploaded content was introduced.

Browser checks run at 1280 px and 390 px for Dashboard, Process Excel, Verification and Settings. Existing browser coverage also exercises My Files, authentication, registration, approval states, dashboard decisions and email confirmation on mobile. Tests use synthetic HTTP fixtures and actual components, rather than production accounts/data.

Screenshots from the settled layouts:

- [Desktop upload](frontend/test-results/ui-copy-clean-settings-and-upload-copy-at-1280px/upload-1280.png)
- [Desktop Settings](frontend/test-results/ui-copy-clean-settings-and-upload-copy-at-1280px/settings-1280.png)
- [Mobile upload](frontend/test-results/ui-copy-clean-settings-and-upload-copy-at-390px/upload-390.png)
- [Mobile Settings](frontend/test-results/ui-copy-clean-settings-and-upload-copy-at-390px/settings-390.png)

Screenshots are generated test artifacts and may be replaced by later browser runs. Desktop upload and mobile Settings screenshots were also visually inspected.

## Checks

| Check | Result |
| --- | --- |
| Frontend Node/PostgreSQL tests | 34 passed |
| Full Playwright suite | 17 passed |
| Final affected-page Playwright check after the last copy edit | 5 passed |
| Final source-copy regression check | 3 passed |
| ESLint, zero warnings | Passed |
| TypeScript, no emit | Passed |
| Production Next.js build, including final type/lint checks | Passed |
| `git diff --check` | Passed |

The browser regression intentionally supplies a filename and cell value containing unusual/previously corrupted characters and confirms they remain verbatim. Display-copy fixes do not alter user accounting data or filenames.

## Preserved behavior and limits

No backend files, calculation rules, monetary aggregation, GRAND TOTAL export, preservation verification, upload/download implementation, Supabase configuration, database migrations, security rules, approval decisions, Gmail notifications or retention behavior were changed. Middleware and authentication-component changes affect displayed wording only.

No remaining encoding corruption was detected in frontend-owned static copy. User-provided data and server-supplied error details are preserved verbatim; pre-existing characters or technical wording supplied by those external sources are not silently rewritten or suppressed. Fonts may render valid Unicode glyphs differently by device.

No production data was changed. No commit, GitHub push or deployment was performed.
