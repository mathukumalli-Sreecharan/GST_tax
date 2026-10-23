# Administrator notification delivery

This release sends only verified-registration request emails. Supabase Auth's existing trigger persists the request once per user (`request:<UUID>`); a sleeping backend does not lose it. The backend already runs a startup delivery pass and polls every 30 seconds while running. Migration 005 excludes decision events from claims without deleting or resetting any records. Decision events continue to be written transactionally with approval/audit updates, preserving existing approval behavior and history.

## Deployment steps (manual)

1. Apply only unapplied Supabase migrations in order through `005_admin_request_notifications.sql`. An installation already on 004 needs only 005. Do not rerun owner bootstrap or old migrations.
2. Set backend and independent scheduler environment variables:
   - `EMAIL_FROM=GST Ledger Studio <onboarding@resend.dev>`
   - `ADMIN_NOTIFICATION_EMAIL=mathukumalli.sreecharan@gmail.com`
   - `RESEND_API_KEY`: the server-only Resend key authorized for that Gmail.
   - `APP_BASE_URL`: the deployed frontend origin, e.g. `https://your-frontend.example` (no path). The local `.env` currently uses `http://localhost:3000`; do not copy that value to Render.
   - Retain existing Supabase service credentials and administrator UUID.
3. Deploy the updated backend manually. No frontend code change is required. Keep both web and scheduled workers on this version. `render.yaml` already supplies a five-minute maintenance cron using the shared environment group; confirm that it actually exists and is enabled. Its command `python -m backend.maintenance` includes notification delivery. A separate trusted scheduler can instead execute `python -m backend.notifications` with the backend environment. These commands perform real delivery and should only run after the intended configuration is reviewed.
4. Register and verify a new test account. Confirm one request email to the administrator with applicant name, verified email, original registration timestamp in UTC, and `/admin/approvals` on the production frontend. Repeated login/profile updates must not generate another request. Approving/rejecting must send no applicant decision email. Check provider acceptance and Gmail separately.

## HTTP 403 diagnosis and recovery

The previous worker claimed every event kind. Decision payloads targeted applicants, which conflicts with the Resend test sender restriction. Existing request payloads also retain their first recipient/sender even after environment changes. These are code-supported explanations for the reported 403s; historical production records/provider logs were not accessed and the exact historical cause is not confirmed. A 403 can also involve API key permissions or sender authorization. The updated diagnostic identifies these checks without storing provider response bodies or credentials. See [Resend errors](https://resend.com/docs/api-reference/errors).

Before any manual recovery, inspect outbox `kind`, `state`, `payload.from`, `payload.to`, `attempts`, `first_attempt_at`, `last_error`, `provider_id`, and `sent_at` alongside Resend logs. No database records are reset by this release. Eligible request failures retry automatically with the original payload and `gst-approval/<outbox UUID>` key. Decision failures remain retained and unclaimed. Frozen requests with a different recipient/sender or unexpected payload fields are blocked before HTTP delivery and follow existing retry/review handling; they are never silently redirected. Do not rewrite or reset them blindly. Old ambiguous attempts and exhausted retries require reconciliation with Resend before any explicitly reviewed recovery.

Leases, fencing tokens, exponential backoff, eight-attempt cap and the 23-hour review cutoff remain intact. Resend [retains idempotency keys for 24 hours](https://resend.com/docs/dashboard/emails/idempotency-keys). The service checks one configured Gmail recipient and rejects additional recipients/CC/BCC; Resend itself verifies that this address is authorized for its test sender. Backend code cannot determine Resend account ownership offline.

## Render Free timing and limits

[Render Free](https://render.com/docs/free) sleeps after 15 minutes without inbound traffic and can take about a minute to wake. Supabase registration/verification writes directly to the database and does not itself wake Render. The web polling loop cannot run during sleep. Without an independent scheduler, delivery can wait indefinitely until a backend request wakes the service. While awake, a small queue is normally picked up on the next 30-second pass, plus provider latency; five messages are claimed per pass and backlogs/retries take longer.

The supplied five-minute maintenance cron drains up to 50 messages per run independently of web sleep. Scheduling/startup delays, cleanup work, provider outages and retry backoff can extend that interval. Render cron is a separate paid service; this repository does not provision it automatically. An always-running service or enabled independent scheduler is required for delivery independent of user traffic. No new public send-email endpoint or keep-alive traffic was added.

`sent` means accepted by Resend, not guaranteed Gmail inbox placement. Tests use HTTP doubles and embedded PostgreSQL; no live email or production mutation was performed. The existing Render Blueprint specifies paid Starter services; this release does not change hosting plans.

## Render HTTP 403 investigation

The successful manual text, HTML and idempotency tests and verified stored payload make message format and recipient restrictions weaker explanations for the current incident. The leading hypothesis is edge rejection of Python urllib's default `Python-urllib/<version>` client signature. No matching Resend API log is consistent with an edge block, but is not conclusive: a different API key/account, Render egress restrictions or an intermediary can also explain it. Historical response bodies and the actual PowerShell command were not available for comparison.

The minimal request change explicitly sets `User-Agent: GST-Ledger-Studio/1.0` and `Accept: application/json`. Method, URL, Bearer authentication, JSON payload bytes and idempotency key remain unchanged. Compared with the reported successful PowerShell request, the application already uses POST, JSON and Bearer authorization; client headers and execution environment are the principal known differences. Text versus HTML and the idempotency header are already ruled out by the manual tests. See [urllib documentation](https://docs.python.org/3/library/urllib.request.html) and [Cloudflare error 1010](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/).

### Temporary safe diagnostics

Set `RESEND_DIAGNOSTICS=1` manually on both the Render API and maintenance cron while investigating. Diagnostics are disabled by default. The existing Blueprint points both services at the `gst-ledger-beta` environment group, but this does not prove the live services use that group or lack service-specific overrides. The API reads process environment; the CLI/maintenance loads `.env` with dotenv's default behavior, which does not override already set environment variables. Check both services separately for stale keys and stale deployed revisions.

On HTTP failures, opt-in logs contain status, an allowlisted provider code and a canonical sanitized message, plus recognized content type/server, validated Cloudflare ray ID and numeric retry delay. Unknown bodies/messages are withheld. No raw response, arbitrary header, request body, applicant identity, Authorization header, lease token or idempotency header is logged. The existing outbox `last_error` stores a short sanitized status/code/summary, even when temporary logging is disabled. JSON validation, restricted-key and test-recipient failures are distinguished from non-JSON edge error 1010. A Cloudflare server header alone does not establish an edge rejection; inspect the code as well. Unknown messages are deliberately summarized rather than copied because they can echo private data.

Run this read-only command locally and in each Render service environment:

```text
python -m backend.notifications --check-config
```

It performs no database RPC or email request. Compare the 12-character SHA-256 `key_fingerprint` values; a mismatch proves different effective keys. Matching values provide a practical comparison, not a proof of key permissions/account ownership. For a full comparison, set `RESEND_EXPECTED_KEY_SHA256` to the full SHA-256 digest of the known-working trimmed key, then rerun: `expected_key_matches` must be true. Never put the actual key in this digest variable. No expected digest yields null, not a successful match. `key_present`, `key_format_valid` and `key_whitespace_trimmed` flag missing/malformed configuration without printing the key. The local check confirms presence and plausible format; remote configuration cannot be confirmed from this workspace.

After manual deployment, observe only normal eligible retries or a deliberately authorized new signup. Do not reset attempts, alter frozen payloads or replay old records to collect diagnostics. The updated code keeps all existing outbox/lease/idempotency handling. Disable `RESEND_DIAGNOSTICS` after diagnosis. If 1010 persists with the explicit application User-Agent, use the safe ray ID/status to investigate with the provider; do not assume recipient restrictions from status 403 alone. No production access, email send, push or deployment was performed for this investigation.
