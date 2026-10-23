# Private beta validation — 23 October 2026

These checks were executed locally against the current implementation. No changes were committed or pushed.

| Check | Result |
|---|---|
| `python -m pytest -q` | 110 passed, 1 skipped |
| `npm test` | 22 passed |
| `npm run test:browser` | 10 passed in Chromium |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with zero warnings, including Next.js and React Hooks rules |
| `npm run build` | Passed, including `/my-files` and both admin routes |
| `npm audit --json` | Zero reported vulnerabilities |
| Render YAML / Vercel JSON parsing | Passed |
| Frontend static-bundle scan against configured privileged Supabase/Resend keys | No matches |
| Tracked-file scan for real env files, private keys and accounting documents | No matches found |
| Diff of `gst_calculator.py`, `excel_processor.py`, `verification.py` | Unchanged |
| Live read-only Supabase Auth settings check | Frontend publishable key accepted; email registration enabled and email auto-confirm disabled |

The read-only check found the old local backend publishable key was rejected (HTTP 401). The local backend was updated to the accepted frontend key. The owner UUID and privileged credentials were preserved. This does not update Vercel or Render environment variables automatically.

The skipped test requires optional original/reference accounting workbook fixtures that are not present. Synthetic workbook tests cover all four rates, Decimal/threshold behavior, formatting, read-only sources, protections and duplicate-rate prevention.

## Coverage and limits

- Python tests exercise authentication, approval states, owner APIs, all protected Excel/history endpoints, cross-user isolation, persisted downloads after session-state loss, deletion, storage/database failures, cleanup retries, upload limits and existing Excel regressions.
- PGlite executes the actual migration SQL against PostgreSQL with test Supabase Auth/Storage schemas. Tests verify RLS, service-only function execution, owner preservation across additive migrations, transactional auditing/outbox writes, verified registration events, 30-day expiry, deletion leases, abandoned uploads, deleted-account cleanup and notification restart recovery.
- Chromium tests render the real components with synthetic API/auth adapters. They cover public registration/login/logout controls, pending/rejected/revoked screens, approval-status refresh, admin confirmation actions, My Files search/sorting/pagination/download/delete, loading/error/empty states, mobile overflow/navigation and upload/mapping/download with read-only and persistence-failure messages.
- Browser tests do not authenticate against a live Supabase project. Provider tests do not send real email. A mocked accepted email is not proof of mailbox delivery.
- The initial lint run found four issues, which were corrected; the final lint run passed. The browser harness initially hit a Windows process-cleanup delay; it now shuts itself down and the final run completed normally.

## Owner action before inviting auditors

Apply only migrations 003 and 004 to the already configured project; preserve the existing owner setup. Configure the Vercel and Render environments, private bucket and independent cron job using `BETA_DEPLOYMENT.md`. Rotate previously exposed privileged credentials manually, use a verified Resend domain for applicant notifications, and perform the two-account/live-email deployment acceptance steps there. Rotation and live deployment have not been verified here.
