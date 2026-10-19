# Vendor Portal Build Plan

Status: plan only. Nothing here has been built yet. Written 2026-10-15, updated 2026-10-19.

## Context for the builder

- Project: E. Chabot Ltd. PLM. Repo `bshabot/echatbot`, local folder `echatbot`. Stack: Vite + React 19 + Tailwind, `@headlessui/react` v2, Supabase (project ref `ujwdpieleyuaiammaopj`), deployed on Netlify (site `echabot-plm`, at db.echabot.com). Netlify functions live in `netlify/functions` (existing: `ssp-proxy.mjs`, `ssp-image-proxy.mjs`, `ssp-refresh-token.mjs`). Migrations live in `supabase/migrations`.
- The grid to reuse: `src/components/Samples/BulkAddSamplesModal.jsx` (branch `bulk-add-excel-grid`, not yet pushed; push it from GitHub Desktop before branching). It is an Excel-style grid: paste, drag-fill, undo, a stones popover, a Detail column and auto-description. It currently talks directly to Supabase, the `settings` row, the metal price store and the stone form's stores, so it must be made injectable (see Vendor page).
- Existing save path to reuse on approval: `src/utils/formatImportRow.js` and `src/utils/insertSampleRows.js` (`insertFormattedSampleRows`).
- Auth today: Supabase Auth for staff only (`src/Pages/Login.jsx`, `SupaBaseProvider.jsx`). `App.jsx` has an unauthenticated `Routes` branch when there is no session.
- Do not store or print secrets. The server key used by the Netlify function lives only in Netlify environment variables.
- Sandbox note from earlier work: git commits from the Cowork device VM need a one-off `-c user.name` and `-c user.email`, and there is no delete permission until granted.

## Goal and decisions

Vendors enter their items into the PLM through a private page that can only add rows and manage their own submissions, and sees nothing else.

| Question | Decision |
| --- | --- |
| How vendors get in | Vendor login with email and password. Our own accounts, not Supabase Auth, so vendors never get a database session. |
| Where submissions land | A staging table. Staff approve before anything reaches samples. |
| What vendors fill in | Technical fields only: style/code, metal, karat, color, weight, dimensions, plating, stones, detail, description. No Sales Price, Labor Cost, Location or stock. |
| Can vendors see their items | Yes, only their own, to fix mistakes (see Vendor page). |
| Photos | Not in v1. Needs a separate size- and type-limited upload path to R2. |

## Why it must be locked down

The PLM database today gives every logged-in user full read and write on every table, so a vendor with a normal login could see and edit the whole catalog. Checked on the live project:

| Table | Row-level security | Anon (public key) | Logged-in user |
| --- | --- | --- | --- |
| samples | on | read | full access |
| starting_info | on | read | full access |
| stones | on | read | full access |
| images, image_link | on | read | full access |
| vendors | on | read | full access |
| category | on | none | full access |

Two consequences. Vendors get no Supabase account, only session-checked functions behind our own login. And the existing anon read on the catalog tables is a separate exposure that exists today, independent of this feature; worth tightening once the portal is live.

## Database design

One additive migration. Vendors never touch a table; every vendor request goes through our own login and a server function, and the database functions behind it can only be called by that function.

**Tables** (row-level security on, staff-only policies, no policy for anon or for vendors)

- `vendor_accounts`: vendor, email (the login name), password hash (argon2id with a per-account salt; the password itself is never stored), enabled flag, failed-attempt count and lock-until time, must-change-password flag, last login.
- `vendor_sessions`: account, hashed session id, idle and absolute expiry, last seen, revoked flag. The raw session id lives only in the vendor's cookie.
- `vendor_submissions`: vendor, the account that submitted, batch id, row data as JSON, status (pending, approved, rejected, needs changes), review note shown to the vendor, internal note never shown, version, previous version, resulting sample id.
- `vendor_audit_log`: time, account, action, outcome. No passwords or session ids.

**Portal functions** (callable only by the Netlify function's server key; revoked from anon and from logged-in users). Each resolves the vendor from the session, never from an id the caller supplies.

| Function | What it does |
| --- | --- |
| `vendor_login_lookup(email)` | Returns the stored hash and lock state so the server function can check the password. Callable only by the server key. |
| `vendor_session_create` / `vendor_session_end` | Creates and revokes a session. |
| `vendor_portal_info(session)` | Vendor name and the dropdown choices the form needs. Nothing else. |
| `vendor_portal_submit(session, rows)` | Validates and inserts rows as pending. Capped rows per call, field lengths and an allow-list of columns. |
| `vendor_portal_my_submissions(session)` | That vendor's own rows, status and review note only. |
| `vendor_portal_update(session, id, data)` | Edits one of their own rows, only while pending, rejected or needs changes. Bumps the version and keeps the old one. |
| `vendor_portal_withdraw(session, id)` | Withdraws one of their own pending rows. |
| `vendor_portal_correction(session, id, note)` | Adds a correction request to an approved row. Does not change the sample. |

**Staff-only functions:** create a vendor account (issues a temporary password shown once, forced change at first login), reset a password, disable an account, and revoke all of an account's sessions.

**Passwords:** at least 12 characters, checked against a list of common passwords, no composition rules. Staff can reset but never see a password. Account lock after repeated failures.

Every function is `security definer` with a fixed `search_path` and returns the same generic error for any invalid, expired or revoked session.

## Vendor page

A public route like `/vendor`, outside the staff app, behind a password login, with two tabs.

**Add items.** The Bulk Add grid in a vendor mode: paste from Excel, fill, undo, stones, Detail and auto-description all work. Columns are technical only, the vendor is fixed by the logged-in account, and saving calls `vendor_portal_submit` instead of writing to the catalog. It makes no calls to internal stores or settings and keeps no local draft of anything but the vendor's own rows. The main refactor is making the grid's data access injectable: it currently talks to the database, settings, metal prices and the stone form's stores directly.

**My Submissions.** Lists only that vendor's rows with status (Pending, Approved, Rejected, Needs changes) and your review note.

| Row status | What the vendor can do |
| --- | --- |
| Pending | Edit or withdraw. Nothing is in the catalog yet. |
| Rejected or Needs changes | Correct and resubmit; the row returns to Pending for staff. |
| Approved | Read-only. They can send a correction request, a note attached to the row that staff see; staff decide whether to change the sample. |

Every edit is stamped and keeps the previous version, so staff can see what changed. If a vendor edits a row while it is open for review, approval applies only to the version staff saw; if it changed since, approval is blocked until the reviewer reloads.

## Staff side

A new Vendor Submissions view in the PLM, for logged-in staff only.

- Pending rows grouped by vendor and batch, with edit-before-approve.
- Actions: Approve, Reject, and Needs changes, each with a note field. The note is what the vendor sees.
- Approve runs the existing `formatImportRow` and `insertFormattedSampleRows`, so approved rows become real samples through the same path as Import and Bulk Add. The row then links to the new sample id.
- Markers for rows a vendor edited since submission, and for correction requests on approved rows.
- Duplicate style numbers are flagged for review rather than overwritten.
- A vendor accounts admin on the Vendors page to create accounts, reset passwords, disable accounts, end sessions, and see last login and recent activity.

## Security: database, server side and browser

The aim is that a vendor, or anyone holding the public key, can do only what the portal allows, enforced at three layers so one mistake is not enough.

**Layer 1: database**

- Row-level security on the new tables with no policy for anon or for vendors; neither can read or write them directly.
- Passwords are stored only as argon2id hashes and session ids only as hashes, with idle and absolute expiry and revocation. Invalid, expired and revoked sessions return the same generic error.
- Every function is `security definer` with a fixed `search_path`, filters by the vendor the session resolves to (never by an id the caller supplies), and uses an allow-list of columns, so extra keys such as price or sample id are dropped.
- Hard caps: rows per call, length of every field, size of the JSON, and total pending rows per vendor.
- An audit log (time, account, action, outcome) with no passwords or session ids in it, and a failed-attempt counter that temporarily locks an account.

**Layer 2: server side (Netlify)**

- Vendor traffic goes through one Netlify function instead of calling Supabase from the browser. The function checks the session, body size and content type, rate-limits per IP and per account, and only then calls the database. The portal database functions are revoked from anon and from logged-in users, so only that function can call them, using a server-held key that never ships in the browser bundle. Holding the public key alone gets nothing.
- The function exposes a fixed set of actions and passes nothing through, so a vendor cannot reach any other table, function or storage path.
- Responses send `Cache-Control: no-store`, a strict CORS origin, and no stack traces or database error text.

Login and sessions:

- Login returns the same generic error and takes about the same time for an unknown email and a wrong password (a dummy hash is checked for unknown emails), so accounts cannot be discovered. Attempts are rate-limited per IP and per account, with growing lockouts.
- The session is an HttpOnly, Secure, SameSite=Strict cookie with idle and absolute expiry. Logout and staff disable revoke it on the server at once.
- State-changing requests are checked against the origin and a custom header, on top of SameSite, to block cross-site requests.
- Passwords are stored only as argon2id hashes; no role, including staff, can read one back.

**Layer 3: browser**

- The vendor page is its own build entry, so it ships none of the internal app: no stores, no catalog queries, no metal-price sync.
- The session cookie is not readable by page scripts, passwords never appear in URLs or browser storage, the page sends `noindex` and `Referrer-Policy: no-referrer`, and a strict Content-Security-Policy limits where it can connect.
- Vendor text is only ever rendered as plain text, never as HTML.
- Reviewer-side views escape vendor-entered text the same way, since staff will read it.

**Tests that must pass before it goes live**

| Test | Pass condition |
| --- | --- |
| Anon role and a logged-in staff-style user, direct reads and writes on the new tables | All denied |
| Anon and logged-in roles calling the portal functions directly | Denied; only the server key works |
| Vendor A's session against vendor B's rows (read, edit, withdraw) | Same error as no session |
| Login with unknown email versus wrong password | Same text, same status, similar timing |
| Repeated wrong passwords | Throttled, then the account locks |
| Cookie flags on login | HttpOnly, Secure, SameSite=Strict present |
| Cross-site request without the origin and header checks | Rejected |
| Reuse of a session after logout, expiry or account disable | Rejected immediately |
| Password hashes and session hashes read by any role | Unreadable by anon, vendors and staff screens |
| Extra and forbidden fields (price, sample id, status) in a submission | Dropped or rejected, never stored |
| Oversize rows, too many rows, long fields, odd Unicode, script tags | Rejected or stored as inert text |
| Edit or withdraw on an approved row | Refused |
| Built vendor bundle searched for internal table names, store code and keys | None found |
| Response headers on the page and functions | no-store, CSP, no-referrer, noindex present |
| Supabase security advisors after the migration | No new warnings |

The tests run as scripts against a staging copy first, then once against production with a throwaway vendor account that is deleted afterward.

## Build order and open items

Security tests run at the end of each step, not only at the end of the project.

1. Migration: accounts, sessions, submissions, audit log, functions, staff account management. Anon-role tests.
2. Netlify functions: login, sessions, rate limits, lockout, CSRF checks, caps and headers. Revoke anon and logged-in execute on the portal functions. Re-run the tests through the functions.
3. Grid refactor and the separate vendor build entry. Bundle inspection.
4. Vendor page: login screen, Add items, and My Submissions with edit, withdraw, resubmit and correction requests.
5. Staff review view, Needs changes flow, version check on approve, vendor accounts admin.
6. Full test table against staging, then production with a throwaway account.
7. Pilot with one vendor before creating accounts for the rest.

**Open items**

- Photos are left out of v1; they need their own upload path with size and type limits.
- Duplicate style numbers are flagged for review; say if you would rather block them at submit.
- Password recovery: v1 has staff reset only, issuing a new temporary password. Self-service reset by email is a later option.
- Optional 2FA for vendor accounts is not in v1; worth adding if you want it from day one.
- Auto-SKU rules (remaining prefixes, charm endings, how the next number is picked) are still waiting on answers.
- The existing anon read on the catalog tables is outside this feature; decide whether to tighten it after launch.
- Work happens on a new branch off `bulk-add-excel-grid`, which still needs pushing from GitHub Desktop.
