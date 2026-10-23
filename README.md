# GST Ledger Studio

An approval-controlled private beta for Excel GST automation, with the existing Next.js corporate interface, FastAPI/OpenPyXL processing, Supabase Auth, private generated-file history and owner-only administration. All approved auditors have free access.

## Private beta release

- Apply only new migrations 003 and 004 to an already configured approval project; they preserve the designated owner.
- My Files (`/my-files`) retains private generated workbooks for 30 days, across sessions and devices.
- Every processing, history, download and deletion request requires a currently approved, verified account.
- Configure the independent Render maintenance cron before inviting auditors.
- Follow [BETA_DEPLOYMENT.md](BETA_DEPLOYMENT.md) for Vercel/Render settings, storage policies, security tasks and live acceptance.
- Owner setup details: [APPROVAL_SETUP.md](APPROVAL_SETUP.md). Read-only handling: [READ_ONLY_SUPPORT.md](READ_ONLY_SUPPORT.md).

Validation commands:

```powershell
.\env\Scripts\python.exe -m pytest -q
cd frontend
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test:browser
npm.cmd run build
```

Browser tests use Playwright Chromium (`npx playwright install chromium` on a fresh machine). They exercise real components with synthetic API fixtures; no real credentials or customer files are used.

## Run locally on Windows

Use two PowerShell terminals from the project directory.

### 1. Install and start the backend

```powershell
python -m pip install -r requirements.txt
python -m uvicorn backend.main:app --reload --env-file .env --host 127.0.0.1 --port 8000
```

### 2. Install and start the frontend

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:3000`. The frontend calls the local API at `http://localhost:8000`. Set `NEXT_PUBLIC_API_BASE` if you need a different local backend address.

## Workflow

1. Upload an `.xlsx` workbook (20 MB maximum) and select a worksheet.
2. Confirm or change detected Invoice Value and Taxable Value columns; Invoice Number is optional.
3. Review the first data row and, if present, the existing `Rate(%)` column behavior.
4. Calculate, inspect results and verification rows, then download the updated workbook and separate CSV report.

Existing GST logic remains in the existing modules: expected taxable value is Invoice Value × 100 / (100 + GST rate), using the supported 5%, 12%, 18% and 28% rates. Differences below ₹1 match; ₹1 to less than ₹50 assigns the nearest rate and flags verification; ₹50 or greater leaves the rate blank. Ambiguous/invalid rows remain flagged. Existing Rate(%) values are kept unless recalculation is explicitly confirmed.

## Excel preservation

Workbook editing stays in OpenPyXL. The output keeps the original sheets and workbook layout while inserting only the Rate(%) column. When OpenPyXL cannot safely preserve a workbook feature or update formula references, processing stops with a clear error instead of returning a potentially damaged file. Existing rate columns are reused; choosing to keep them returns an exact copy of the input package. Generated files are stored in a local temporary directory and their opaque download IDs expire after one hour.

## Tests and build

From the project root:

```powershell
python -m pytest -q
```

From `frontend`:

```powershell
npm.cmd run build
```

The regression tests use the KK May and KK April original/updated workbook pairs present in this project.

## Supabase authentication setup

1. Create a Supabase project. In Authentication > Providers, enable Email and **Confirm email**. Set a minimum password length of 12 and configure production SMTP and rate limits.
2. Copy the project URL and **publishable** key into `frontend/.env.local` using `frontend/.env.example`. Copy `.env.example` to `.env` for FastAPI. Never use service-role or secret keys in these settings. Environment files are ignored by Git.
3. In Authentication > URL Configuration set Site URL to your frontend origin. Allow exactly `http://localhost:3000/auth/callback` and `http://localhost:3000/auth/callback?flow=recovery` for development, plus their HTTPS production equivalents. Avoid wildcard production redirects. Keep the default confirmation and recovery email templates using `{{ .ConfirmationURL }}` so Supabase returns a PKCE code. Links must be opened in the browser that initiated the request.
4. Run `supabase/migrations/001_profiles.sql` once in the SQL editor. It creates profiles, ownership policies, timestamps and the registration trigger. User metadata/full names are display information, never permission or billing claims.
5. Prefer an asymmetric JWT signing key (ES256 or RS256) in Supabase. FastAPI verifies signatures with cached JWKS and enforces expiration, issuer, authenticated audience/role, and UUID subject. Legacy HS256 sessions are verified by Supabase Auth before application claims are checked. The health endpoint is public; all Excel endpoints require a bearer token.
6. Start both servers as above. Serve production over HTTPS and set `CORS_ORIGINS` to the exact frontend origin. Do not cache authenticated pages or callback responses in a CDN. Next.js 15 uses `middleware.ts` to refresh cookies; the dashboard and reset page also verify the user on the server.

Routes: `/login`, `/register`, `/forgot-password`, `/reset-password`, and `/auth/callback`. The existing dashboard, processing, verification and settings workspace remains at `/`, protected as a whole. Return destinations are restricted to local application paths. Supabase SSR stores sessions in cookies with PKCE; the browser client manages refresh. Tokens are sent to FastAPI only in Authorization headers. Recovery responses are generic regardless of account existence. Signed-in users may also change their password on the reset page after server verification.

On session expiry the workspace opens a sign-in dialog and retains its source File in memory. Sign in with the same account, then retry the action. Closing/reloading the tab or explicitly signing out releases that in-memory state. Downloads remain owned by the original user.

Temporary Excel files live in a private process directory; inspected sources are deleted immediately and results expire after one hour, with a cleanup task every minute and deletion on shutdown. Run **one FastAPI worker**: result metadata is in memory and downloads do not survive restarts. Use a private OS account/disk and OS temporary-directory cleanup for crash leftovers. Multi-worker deployment requires shared owner-scoped result metadata and private object storage with lifecycle deletion before scaling. No billing, trial or usage-limit logic is included; add it separately using the authenticated UUID.

### Validation and live acceptance

Run `python -m pytest -q`, then `npm.cmd test` and `npm.cmd run build` in frontend. Automated tests cover JWT claims, invalid/missing credentials, cross-user files, authenticated processing/download and GST regressions. No Supabase credentials are included, so live email delivery and provider flows need this acceptance pass after configuration:

- Register a new email; invalid emails/password mismatches must fail; verify the email and sign in.
- Check incorrect-password errors, refresh persistence, sign-out, and unauthenticated dashboard redirects.
- Request recovery for an existing and nonexistent email; both show the same response. Follow a valid link, change password, and check reused/expired links fail.
- Expire a workspace session, sign in through its dialog and retry without choosing the workbook again.
- Use two accounts to confirm workbook/report IDs cannot cross account boundaries.

Integration follows the official [Supabase SSR guide](https://supabase.com/docs/guides/auth/server-side/creating-a-client) and [JWT verification guide](https://supabase.com/docs/guides/auth/jwts).


See BETA_VALIDATION.md for the latest executed checks and remaining live-deployment acceptance tasks.
