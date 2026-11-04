# Vendor portal: setup and go-live

Companion to `vendor-portal-build-plan.md`. Everything here is built on the `vendor-portal` branch. Nothing has been applied to the live Supabase project.

## What was built

| Piece | Where |
| --- | --- |
| Migration (tables, RLS, portal and admin functions, grants) | `supabase/migrations/20261019000000_vendor_portal.sql` |
| Database security tests (50 checks) | `supabase/tests/vendor_portal_security.sql` |
| Vendor function (login, sessions, rate limits, lockout, CSRF, caps, headers) | `netlify/functions/vendor-portal.mjs` |
| Staff account function (create, reset, disable, end sessions) | `netlify/functions/vendor-admin.mjs` |
| Shared server helpers (argon2id, password policy, cookie, checks) | `netlify/vendor-lib/shared.mjs` |
| Vendor page, separate build entry | `vendor.html`, `src/vendor/*` |
| Staff review view | `src/Pages/VendorSubmissions.jsx` (route `/vendor-submissions`) |
| Vendor logins admin | `src/components/Vendor/VendorAccounts.jsx` (bottom of the Vendors page) |
| Approval mapping | `src/utils/vendorSubmissionToImportRow.js` then the existing `formatImportRow` and `insertFormattedSampleRows` |
| Live-site checks | `scripts/test-vendor-portal.mjs`, `scripts/check-vendor-bundle.mjs` |

Not built yet: the Excel-style grid on the vendor Add items tab (it is a simple form plus paste-from-Excel for now, until the Bulk Add grid is merged and made injectable), photos, 2FA, self-service password reset.

## Go-live steps

1. Run `npm install` (adds `hash-wasm`, the argon2id library, which is pure WebAssembly so it bundles on Netlify with no native build).
2. In Netlify site settings, add environment variables (server only, never `VITE_`-prefixed):
   - `SUPABASE_URL` (the project URL)
   - `SUPABASE_SERVICE_ROLE_KEY` (the server key from the Supabase dashboard, API settings)
   - optional `VENDOR_PORTAL_ORIGINS` (comma-separated extra allowed origins, for a staging domain)
3. Apply the migration to a staging copy first. Then run `supabase/tests/vendor_portal_security.sql` against it (`psql -f`, as the postgres role). Every line must say PASS and `failures` must be 0.
4. Check Supabase security advisors: no new warnings.
5. Deploy. Run `npm run build && node scripts/check-vendor-bundle.mjs` (must PASS).
6. In the PLM, Vendors page, create a throwaway login for a vendor. Sign in at `/vendor`, choose a password, then run:

   ```
   BASE_URL=https://db.echabot.com VP_EMAIL=... VP_PASSWORD=... node scripts/test-vendor-portal.mjs
   ```

7. Delete the throwaway account and its test rows. Pilot with one real vendor before creating the rest.

## Security notes

- Vendors never get a Supabase session. The browser only calls `/.netlify/functions/vendor-portal`.
- The portal and admin database functions are revoked from `anon` and `authenticated`; only the server key can run them. Staff cannot read `password_hash` (column grant omits it) or `vendor_sessions`.
- Passwords: argon2id, 12+ characters, common-password list, forced change at first login, lockout after 5 misses with growing delay, per-IP and per-email rate limits.
- Session cookie: `__Host-vp`, HttpOnly, Secure, SameSite=Strict, 30 min idle and 12 h absolute, revoked on logout, password change, disable and staff reset.
- Headers for `/vendor`: strict CSP, `no-referrer`, `noindex`, `no-store` (see `netlify.toml`).
- The existing anon read on the catalog tables is a separate, pre-existing exposure; consider tightening it after launch.
