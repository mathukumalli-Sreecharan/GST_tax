# Manual beta approval setup

The code enforces approval on every Excel inspection, processing, workbook download and verification-report download. No environment flag disables this check. Missing credentials, unavailable PostgreSQL, an unset owner or an owner not explicitly approved all fail closed. Public registration, sign-in, verification and recovery routes remain available.

## 1. Prepare your owner account

Keep public signups enabled in Supabase Authentication. Enable email confirmation under the Email provider. Register your own account and verify its email before bootstrap. In Supabase Authentication > Users, copy its **Auth user UUID**. The owner is never selected by email, signup order, name, metadata or browser state.

## 2. Configure backend environment

Add the following to the existing root `.env` (not to any `NEXT_PUBLIC_` variable):

```dotenv
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_PUBLISHABLE_KEY=YOUR-PUBLISHABLE-KEY
SUPABASE_SERVICE_ROLE_KEY=YOUR-SERVER-ONLY-SERVICE-ROLE-OR-SECRET-KEY
ADMIN_USER_ID=YOUR-VERIFIED-AUTH-USER-UUID
ADMIN_NOTIFICATION_EMAIL=mathukumalli.sreecharan@gmail.com
RESEND_API_KEY=YOUR-RESEND-KEY
EMAIL_FROM=GST Ledger Studio <onboarding@resend.dev>
APP_BASE_URL=http://localhost:3000
CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
```

Use the test sender only for administrator requests to the Resend-authorized Gmail. Applicant decision emails are disabled. `APP_BASE_URL` must be the frontend origin, without a path. Use your HTTPS production origin for deployment. The application accepts a legacy Supabase service-role JWT or a newer backend secret key in `SUPABASE_SERVICE_ROLE_KEY`. These credentials are backend-only. Local `.env` files are ignored by Git.

The existing `frontend/.env.local` needs only the publishable frontend settings shown in `frontend/.env.example`. Optionally set server-only `API_INTERNAL_BASE` there if Next.js reaches FastAPI through a different internal address. Never add backend secrets to the frontend configuration.

## 3. Apply migrations and explicitly approve the owner

Pause application traffic during initial rollout. Use the Supabase SQL editor to apply `supabase/migrations/001_profiles.sql` if it has not already been applied, then `supabase/migrations/002_user_approvals.sql` once. These migrations are ordered, not rerunnable scripts. Existing users default to pending. Existing verified users also get durable notification requests.

From the repository root in PowerShell:

```powershell
.\env\Scripts\python.exe -m pip install -r requirements.txt
.\env\Scripts\python.exe -m backend.setup_owner
```

Bootstrap reads `ADMIN_USER_ID` from `.env`, validates that the account exists and has a verified email, records the designated owner and explicitly approves that account with an audit record. It is idempotent for the same UUID. It refuses to replace a previously configured owner. The API requires the database owner and backend environment UUID to match before enabling access. **Run this before switching traffic to the new version.** No service key is needed by the browser.

Owner changes require an explicit, reviewed database operation and matching environment change; they are deliberately unavailable through the admin UI. The owner cannot reject or revoke their own approval through the application.

## 4. Start the application

```powershell
.\env\Scripts\python.exe -m uvicorn backend.main:app --reload --env-file .env --host 127.0.0.1 --port 8000
```

In the frontend directory:

```powershell
npm.cmd install
npm.cmd run dev
```

Sign in as the owner and open `/admin` or `/admin/approvals`. Only the verified owner UUID can use those pages or the corresponding APIs. Other authenticated users receive a not-found admin page and HTTP 403 from admin APIs. Dashboard counts include all registered accounts; unverified applicants are shown without a verified email and cannot be approved yet.

Regular users can sign in and see pending, rejected or revoked access screens. Pending users see exactly: “Your account is awaiting administrator approval.” The status screen checks again on focus, every 30 seconds, and on a denied Excel request. All backend requests check status independently without an approval cache. A revoked user cannot retrieve an existing workbook or report even while an old browser page remains open. Previously downloaded local files cannot be withdrawn.

## Notifications and recovery

An Auth database trigger inserts a pending approval at signup. Email confirmation queues one administrator notification with a unique request event key. Both are stored independently of the email provider. Names are display-only, email addresses come from verified Auth records, and plain-text notification links open the admin review screen. There are no permission-changing email links.

Each admin decision locks the applicant row, checks the expected previous status, updates the approval, appends the actor/time audit record and retains a decision outbox event in one transaction; decision events are excluded from email delivery. A stale admin screen receives HTTP 409 and must refresh.

The FastAPI lifespan worker drains the outbox every 30 seconds. Missing email configuration does not consume requests. Alternatively, with backend environment configured, a scheduler may run:

```powershell
.\env\Scripts\python.exe -m backend.notifications
```

Multiple workers use PostgreSQL `FOR UPDATE SKIP LOCKED`, short leases and lease tokens to avoid conflicting delivery updates. The first attempt freezes the entire email payload; retries use the same Resend idempotency key. Failures back off up to one hour, with up to eight attempts. `sent` means Resend accepted the email, not that the recipient's mailbox delivered it.

Resend retains idempotency keys for 24 hours. Ambiguous attempts older than 23 hours and exhausted retries move to `needs_review` rather than risk sending a duplicate. Inspect `public.approval_notifications` in the Supabase dashboard: `state`, `attempts`, `last_error`, `provider_id`, `payload` and `sent_at` identify the problem. Reconcile with Resend before any manual resend. Do not blindly reset old ambiguous messages. Approval records remain visible regardless of delivery state; the admin dashboard shows the queued/retrying and review counts.

## Database permissions

RLS permits authenticated users to SELECT only their own approval row. Anonymous users cannot access approval tables. Ordinary users cannot mutate approvals, read other applicants, read audit/outbox/owner tables or call privileged functions. Admin data is fetched through FastAPI using backend credentials after UUID verification; SQL functions independently check the configured owner. Audit history is append-only through the application and ordinary users have no access. Treat SQL-editor access and service credentials as privileged administrative capabilities.

## Validation

```powershell
.\env\Scripts\python.exe -m pytest -q
cd frontend
npm.cmd test
npm.cmd run build
```

Frontend tests include actual PostgreSQL execution through the test-only PGlite dependency, with Supabase Auth roles/schema emulated. They exercise migration triggers, signup/verification, existing-user defaults, RLS, owner setup, decisions, stale updates, auditing, outbox leases, retry payloads and deduplication-window safeguards. Python tests cover JWT enforcement, all four Excel endpoints, approval states, owner-only APIs, cross-user downloads, revocation, email delivery/failure and existing GST regressions.

Before production rollout, verify a real email-confirmation signup, an owner notification in Resend, absence of applicant decision emails and revocation with two separate browser accounts. Automated tests use provider doubles and embedded PostgreSQL; they do not provision a live Supabase project or send real emails.

References: [Supabase database function security](https://supabase.com/docs/guides/database/functions), [Supabase RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys).

Apply only unapplied migrations through `005_admin_request_notifications.sql` before starting the updated worker. Do not rerun bootstrap for the approved administrator. See [NOTIFICATION_DELIVERY.md](NOTIFICATION_DELIVERY.md) for release steps, recovery and Render Free timing.
