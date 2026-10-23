# Private beta release and deployment

All approved users have free access. There are no subscriptions, payments, trials or billing restrictions.

## Release review

The existing application already provided Decimal GST calculations, workbook preservation/read-only handling, Supabase authentication, manual approval, owner-only admin pages, an audit trail and a durable Resend queue. The release extends those modules rather than replacing them.

The review found these gaps and fixes:

| Finding | Release change |
|---|---|
| Workbooks disappeared after process/session expiry | Private Supabase Storage and PostgreSQL history |
| No durable retention cleanup | Independently scheduled Render maintenance job |
| Upload/finalization failures could orphan objects | Metadata reservation before upload, durable tombstones and leased cleanup |
| Approval emails omitted signup time | Additive migration 004 includes registration time in UTC |
| Resend test-sender failures had a generic warning | Explicit recorded test-sender restriction warning; decision remains saved |
| Browser upload limit ran after multipart parsing | Request-body limit plus bounded ZIP/XML validation |
| ZIP expansion and misleading worksheet dimensions could exhaust memory | Expanded-size, part-count, cell-area limits and defused XML parser |
| OS errors could expose internal paths | Generic temporary-storage error response |
| No production manifests/checklist | Render web/cron Blueprint and Vercel frontend config |
| Lint script did not have a working linter | Explicit ESLint configuration and lint command |

The GST calculation module, Decimal precision, classification thresholds, duplicate-rate behavior and Excel processor remain unchanged. Additional upload limits reject unsafe inputs before processing, rather than modifying their contents.

## Database rollout — preserve the existing owner

Back up the database using your normal Supabase process. Apply migrations once and in order in the SQL editor:

1. `001_profiles.sql` — only if not already applied.
2. `002_user_approvals.sql` — only if not already applied.
3. `003_generated_files.sql` — new history table and private Storage bucket/policy.
4. `004_notification_registration_time.sql` — additive notification upgrade.

**Do not rerun migration 002 on an existing configured project.** Migrations 003 and 004 do not reset `approval_owner`, approval statuses or audit history. The administrator UUID remains configured only through backend `ADMIN_USER_ID` and the existing database owner record. Keep its existing value when copying deployment environment variables.

You have already run `python -m backend.setup_owner` successfully. No new owner bootstrap is needed for this release. For a fresh environment, use the steps in `APPROVAL_SETUP.md` after applying migrations and verifying your owner email.

Check in Supabase Storage that `generated-excel-files` is **private**. The migration applies a restrictive policy to block direct browser access even if another broad Storage policy exists. The backend is the only path for uploads, downloads and deletions. Do not add a public policy or expose signed/public URLs. Other buckets are not changed.

## Vercel frontend

No connected Vercel deployment tools are available in this workspace. Configure these settings manually; local environment files are not uploaded automatically.

- Framework: Next.js.
- Root Directory: `frontend`.
- Install Command: `npm ci`.
- Build Command: `npm run build`.
- `frontend/vercel.json` supplies the framework/build defaults.
- Configure the following for the Production environment, then redeploy after changing public variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://YOUR-PROJECT.supabase.co` with no `/rest/v1` path |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key from that same project |
| `NEXT_PUBLIC_API_BASE` | Exact HTTPS Render API origin, without a trailing API path |
| `API_INTERNAL_BASE` | Optional server-only API origin; normally omit so it uses the public Render URL |

Never configure `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY` or other private credentials in Vercel/frontend public variables. Production Vercel builds reject non-HTTPS public Supabase/API URLs.

Protected application routes are `/`, `/my-files`, `/admin` and `/admin/approvals`. Public authentication/recovery routes remain available. Admin authorization is checked on the server and independently by FastAPI; navigation visibility is not authorization.

## Render backend and scheduled maintenance

Create an environment group named **`gst-ledger-beta`** in Render with the following settings. Link it to both the API web service and maintenance cron job. The supplied root `render.yaml` references this group; it must exist before Blueprint setup.

| Variable | Required configuration |
|---|---|
| `SUPABASE_URL` | Same HTTPS project origin used by Vercel |
| `SUPABASE_PUBLISHABLE_KEY` | Same project's publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Rotated server-only service-role JWT or newer secret key |
| `ADMIN_USER_ID` | Your existing designated, verified Auth UUID; do not replace during rollout |
| `ADMIN_NOTIFICATION_EMAIL` | `mathukumalli.sreecharan@gmail.com` (Resend-authorized Gmail) |
| `RESEND_API_KEY` | Rotated backend-only Resend key |
| `EMAIL_FROM` | `GST Ledger Studio <onboarding@resend.dev>` for administrator requests only |
| `APP_BASE_URL` | Exact HTTPS Vercel/custom-domain frontend origin |
| `CORS_ORIGINS` | Exact HTTPS frontend origin(s), comma-separated; no wildcard |

The Blueprint sets `APP_ENV=production` and Python 3.12. The API refuses production configuration with missing/non-HTTPS origins or wildcard CORS. Use actual deployed origins, not the example domains in this document. Frontend and backend must use the same Supabase project.

API service commands, from the repository root:

```sh
pip install -r requirements.txt
uvicorn backend.main:app --host 0.0.0.0 --port $PORT --workers 1 --no-access-log
```

Use `/api/health` as the Render health endpoint. A single worker preserves the existing temporary session-download fallback. Persistent My Files downloads work after restarts; temporary workbooks/reports can disappear after a restart and otherwise expire within one hour. No original upload is stored permanently. Logs contain counts and generic failures, not filenames, financial rows, email bodies, JWTs or private keys.

Create the Render cron service from the Blueprint:

```sh
python -m backend.maintenance
```

Schedule: **`*/5 * * * *` (UTC)**. It deletes expired/abandoned objects through the Storage API before deleting their metadata and drains notification retries even if the web service has restarted. Monitor cron run failures and the notification queue. Render infrastructure may have hosting/cron charges; this does not introduce user billing or access restrictions in GST Ledger Studio.

If creating services manually, give the cron job the same repository, runtime dependencies and environment group as the API. Do not rely solely on FastAPI's in-memory background task for retention.

## Supabase Auth redirects

In Authentication > URL Configuration:

- Set Site URL to the production HTTPS frontend origin.
- Allow the exact production `/auth/callback` and `/auth/callback?flow=recovery` URLs.
- Keep the corresponding `http://localhost:3000` callback URLs only for development if needed.
- Enable public email registration and email confirmation.
- Keep confirmation/recovery templates using `{{ .ConfirmationURL }}` for the existing PKCE flow.
- Configure production email delivery, rate limits and allowed redirect domains in Supabase.

## History, failures and retention

Files are named `{user_uuid}/{file_uuid}.xlsx` in the private bucket. Metadata stores filenames, byte size, processing time, summary counts, warning count and expiry; it does not persist original uploaded workbook bytes or individual invoice rows. `GET /api/files` provides searching, sorting and 20-row pagination. Download and deletion endpoints validate current approval and ownership on every request.

Retention is 30 days from generation. Expired files become undownloadable immediately even before cleanup physically removes them. Physical deletion follows the next successful scheduled run. User deletion hides/disables downloads immediately; if Storage is down, the API returns HTTP 202 and durable cleanup retries the removal.

Upload reservations exist before any Storage write. Failed/ambiguous saves retain a cleanup tombstone for at least an hour so an in-flight upload cannot lose its cleanup record. Stale reservations and deleted Auth accounts are also cleaned. Cleanup uses database leases and tokens and can resume after crashes. Do not delete history metadata manually before removing the associated Storage object.

If persistence cannot be confirmed, the processing response has `history.saved=false` with a warning. The interface keeps the current-session download available when safe and never claims a successful permanent save. Verification CSV reports remain session-only; the durable history stores generated Excel workbooks.

Upload limits: 20 MB uploaded workbook, 21 MB multipart request including overhead, 100 MB total expanded ZIP size, 50 MB per ZIP part, 2,000 parts and a 2,000,000-cell worksheet processing area. History supports generated outputs up to 50 MB. Unsupported workbook features/protection continue to follow the existing preservation rules.

## Resend operation

Apply unapplied migrations through `005_admin_request_notifications.sql`. This release delivers administrator requests only and retains decision events without emailing applicants. See [NOTIFICATION_DELIVERY.md](NOTIFICATION_DELIVERY.md) for deployment and recovery.

Use `GST Ledger Studio <onboarding@resend.dev>` with the authorized administrator Gmail. Applicant decision events are retained without delivery. Eligible requests retry; queued does not mean sent.

`sent`/“accepted” means the provider accepted the message, not confirmed mailbox delivery. Provider delivery/bounce verification is done in Resend. Existing frozen retry payloads are not rewritten during migration, preserving idempotency. New request messages include the applicant's verified email, name, registration time in UTC and review link. There are no permission-changing email links.

See `APPROVAL_SETUP.md` for lease/idempotency windows and manual review of `needs_review` messages. Notification failure never removes the pending approval request.

## Security tasks requiring owner action

- **Rotate the previously exposed Supabase privileged credential and Resend key manually. Rotation has not been performed or verified here.** For legacy JWT-based Supabase service credentials, follow Supabase's rotation process and account for effects on other project clients. Update the backend environment group and local `.env`, then restart both API and cron services. Do not post replacement secrets in chat.
- Verify all production environment values in the hosting dashboards; local `.env` configuration is not evidence of production configuration.
- Keep customer accounting workbooks, exports, private keys and real environment files out of Git. `.env` and `.env.local` remain ignored; the current tracked-file scan found no such files or recognized private-key/credential patterns.

## Release acceptance

Run Python regressions, frontend/database tests, TypeScript, lint and build using the commands in README. Embedded PostgreSQL tests exercise the actual migration SQL and policies while emulating the Supabase-managed schemas. Provider tests use doubles, not live email sends.

Then use two real browser accounts against the deployed environment:

1. Owner can sign in, use Excel and open admin pages; the migration preserved owner approval.
2. New user verifies email, stays pending and appears in admin even if Resend is unavailable.
3. Owner notification contains verified identity, registration time and the correct HTTPS review URL.
4. Pending/rejected accounts cannot use processing, history, downloads or deletion; non-owner admin requests are denied.
5. Approve the auditor, process a workbook with all four rates, then sign out and sign in from another browser; My Files still contains it.
6. Download and verify formatting/rates. Another approved account cannot download/delete it.
7. Revoke the auditor and confirm existing workbook/report/history download requests are denied.
8. Delete a file, check it disappears from metadata and Storage, and verify the scheduled cron handles expiration and failed deletions.
9. Check administrator request acceptance/failures in Resend and the outbox, and confirm decisions send no applicant email. Never claim delivery based only on an approval response.
10. Confirm mobile navigation/tables and error/loading screens remain usable.

No live Vercel/Render deployment or real mailbox delivery has been verified from this workspace. Follow these manual steps before inviting auditors.

References: [Supabase private bucket access](https://supabase.com/docs/guides/storage/buckets/fundamentals), [Supabase object deletion](https://supabase.com/docs/guides/storage/management/delete-objects), [Render cron jobs](https://render.com/docs/cronjobs), [Render Blueprint specification](https://render.com/docs/blueprint-spec).

## Monetary totals and email confirmation release

Apply only unapplied migrations through `006_email_approval_actions.sql`. Deploy the compatible Render backend and Vercel confirmation page before applying 006 to activate new-email links. No new required environment variables or infrastructure are needed. See [ENHANCEMENT_REPORT.md](ENHANCEMENT_REPORT.md) for the complete release order, testing and limitations.
