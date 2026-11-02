# orderstream-bridge

Step 1 of the Signet dropship automation: read open orders from CommerceHub OrderStream (Quick Ship page) into the PLM table `dropship_jobs`. It never ships, invoices or changes stock. GET requests only.

## Setup
1. `npm install`
2. Put ORDERSTREAM_EMAIL and ORDERSTREAM_PASSWORD in `.env` (copy `.env.example`). The job logs in by itself (Playwright) and writes `auth.json`. First run: `npx playwright install chromium`, then `HEADED=1 npm run login` and watch it. Manual fallback: paste the two cookie values into `auth.json`. Never commit either file.
3. Run `sql/dropship_jobs.sql` in the PLM Supabase project (not applied yet) before using `--write`.

## Use
- `node src/sync.js` dry run, prints open orders and parse problems
- `node src/sync.js --write` inserts new orders (needs `SUPABASE_URL` and `SUPABASE_SERVICE_KEY`; see `.env.example`). Existing rows are not changed.
- `node src/sync.js --file page.html` parses a saved Quick Ship page
- `npm test` parser tests (synthetic page)

Exit code 2 means the session expired: paste fresh cookies. The script calls `refreshSession.do` first to extend the 60 minute idle timer.

## Known gaps
- Parser verified only against a synthetic page shaped like the real one. Run it on a real order and check the output before trusting it.
- Orders with any parse problem get `problems` filled in and must not be auto-processed.
- Later steps (label, ship, invoice, stock) are not built. Flow notes are in the project notes.
