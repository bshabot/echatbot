// Regression test for the AddSampleModal new-sample create flow.
//
// Kevin, 2026-10-05: exercises the exact DB sequence AddSampleModal.jsx's
// handleSubmit performs (insert starting_info -> insert stones -> insert
// samples), through the same anon-key Supabase client the real app uses
// (see src/components/SupaBaseProvider.jsx), so this checks real RLS
// behavior, not just JS logic. It is NOT a mock -- it talks to the live
// PLM database, using clearly-tagged, self-cleaning test rows.
//
// Run after any change to the samples/starting_info/stones create path:
//   TEST_PLM_EMAIL=you@echabot.com TEST_PLM_PASSWORD=yourpassword node scripts/test-add-sample-flow.mjs
//
// These three tables (`samples`, `starting_info`, `stones`) are RLS-
// protected: anon (the VITE_SUPABASE_ANON_KEY alone) can only read them,
// same as the running app -- any write needs a real logged-in Supabase
// session, exactly like the app itself requires login before Add Sample
// works. So this script signs in with TEST_PLM_EMAIL/TEST_PLM_PASSWORD
// (your normal PLM login) before running anything, and never stores or
// prints those values. No account is created or guessed -- bring your
// own login.
//
// What it checks:
//   1. Rollback: when the final `samples` insert fails (duplicate
//      styleNumber -> unique violation, same error family as the
//      cad-column bug), the starting_info row created earlier in that
//      same attempt gets deleted -- and its stones cascade with it --
//      so a failed save leaves zero orphaned rows behind.
//   2. Idempotent retry: repeating the exact same failing attempt twice
//      in a row never accumulates more than one attempt's worth of
//      orphans (there should be zero after each, every time).
//   3. Happy path: a normal create still links starting_info -> stones
//      -> samples correctly end to end, then the test cleans up the
//      rows it made itself.
//
// Exit code 0 = all checks passed, 1 = something failed.

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env -- can't run.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const RUN_TAG = `AUTOTEST-${Date.now()}`;
let failures = 0;

async function signIn() {
  const email = process.env.TEST_PLM_EMAIL;
  const password = process.env.TEST_PLM_PASSWORD;
  if (!email || !password) {
    console.error(
      "This test writes to RLS-protected tables, same as the app -- it needs a real login.\n" +
        "Set TEST_PLM_EMAIL and TEST_PLM_PASSWORD (your normal PLM login) and re-run:\n" +
        "  TEST_PLM_EMAIL=you@echabot.com TEST_PLM_PASSWORD=yourpassword node scripts/test-add-sample-flow.mjs"
    );
    process.exit(1);
  }
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error(`Could not sign in as ${email}: ${error.message}`);
    process.exit(1);
  }
}

const check = (label, pass, detail) => {
  if (pass) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
};

// Mirrors AddSampleModal's rollbackOrphanedStartingInfo exactly: delete
// starting_info by id. stones.starting_info_id is ON DELETE CASCADE, so
// any stones created under it go with it in the same statement.
async function rollbackOrphanedStartingInfo(startingInfoId) {
  if (!startingInfoId) return { error: null };
  return supabase.from("starting_info").delete().eq("id", startingInfoId);
}

async function insertStartingInfoAndStone(manufacturerCode) {
  const { data: siData, error: siError } = await supabase
    .from("starting_info")
    .insert([
      {
        manufacturerCode,
        description: "AUTOMATED TEST ROW -- safe to delete if found stale",
        vendor: 17, // Aoxin Jewelry
        metalType: "Silver",
        status: "Working_on_it:yellow",
      },
    ])
    .select("id");

  if (siError) return { startingInfoId: null, siError };
  const startingInfoId = siData[0]?.id;

  const { error: stoneError } = await supabase.from("stones").insert([
    {
      type: "CZ",
      color: "White",
      shape: "Round",
      quantity: 1,
      cost: 0,
      starting_info_id: startingInfoId,
    },
  ]);

  return { startingInfoId, siError: null, stoneError };
}

async function runRollbackScenario(label, styleNumber) {
  console.log(`\n${label} (styleNumber: ${styleNumber})`);
  const manufacturerCode = `${RUN_TAG}-${Math.random().toString(36).slice(2, 8)}`;
  const { startingInfoId, siError, stoneError } = await insertStartingInfoAndStone(manufacturerCode);

  check("starting_info insert succeeded", !siError, siError?.message);
  check("stones insert succeeded", !stoneError, stoneError?.message);

  const { error: sampleError } = await supabase.from("samples").insert([
    {
      styleNumber,
      name: "",
      status: "Working_on_it:yellow",
      selling_pair: "pairs",
      back_type: "none",
      starting_info_id: startingInfoId,
    },
  ]);

  check("samples insert failed as expected (duplicate styleNumber)", !!sampleError, "expected a unique_violation but insert succeeded");
  check("failure was a unique_violation (23505), not something else", sampleError?.code === "23505", sampleError?.code);

  const { error: rollbackError } = await rollbackOrphanedStartingInfo(startingInfoId);
  check("rollback delete ran without error", !rollbackError, rollbackError?.message);

  const { data: orphanCheck } = await supabase
    .from("starting_info")
    .select("id")
    .eq("id", startingInfoId);
  check("starting_info row is gone after rollback", (orphanCheck?.length ?? 1) === 0);

  const { data: stoneCheck } = await supabase
    .from("stones")
    .select("id")
    .eq("starting_info_id", startingInfoId);
  check("stones cascade-deleted with starting_info", (stoneCheck?.length ?? 1) === 0);

  return { startingInfoId };
}

async function main() {
  await signIn();
  console.log(`Running AddSampleModal create/rollback regression test (tag: ${RUN_TAG})`);

  // Find a styleNumber that's guaranteed to already exist, to force the
  // same unique_violation the user hit in production.
  const { data: existing, error: existingErr } = await supabase
    .from("samples")
    .select("styleNumber")
    .not("styleNumber", "is", null)
    .limit(1)
    .maybeSingle();

  if (existingErr || !existing?.styleNumber) {
    console.error("Could not find an existing styleNumber to duplicate -- aborting.", existingErr);
    process.exit(1);
  }
  const duplicateStyleNumber = existing.styleNumber;

  // --- Test 1: single failed attempt rolls back cleanly ---
  await runRollbackScenario("Test 1: rollback on duplicate styleNumber", duplicateStyleNumber);

  // --- Test 2: idempotency -- retrying the same failing save twice in a
  // row must not pile up orphans. Each attempt is independent and must
  // clean up after itself every time. ---
  await runRollbackScenario("Test 2: retry #1 of the same failing save", duplicateStyleNumber);
  await runRollbackScenario("Test 2: retry #2 of the same failing save", duplicateStyleNumber);

  // --- Test 3: happy path still links everything correctly, then the
  // test cleans up its own rows. ---
  console.log("\nTest 3: happy path create + cleanup");
  const happyStyleNumber = `${RUN_TAG}-HAPPY`;
  const manufacturerCode = `${RUN_TAG}-happy`;
  const { startingInfoId, siError, stoneError } = await insertStartingInfoAndStone(manufacturerCode);
  check("starting_info insert succeeded", !siError, siError?.message);
  check("stones insert succeeded", !stoneError, stoneError?.message);

  const { data: sampleData, error: sampleError } = await supabase
    .from("samples")
    .insert([
      {
        styleNumber: happyStyleNumber,
        name: "",
        status: "Working_on_it:yellow",
        selling_pair: "pairs",
        back_type: "none",
        starting_info_id: startingInfoId,
      },
    ])
    .select("id, starting_info_id");

  check("samples insert succeeded", !sampleError, sampleError?.message);
  check("sample linked to the right starting_info_id", sampleData?.[0]?.starting_info_id === startingInfoId);

  const { data: stoneLinkCheck } = await supabase
    .from("stones")
    .select("id")
    .eq("starting_info_id", startingInfoId);
  check("stone still present and linked after a successful save", (stoneLinkCheck?.length ?? 0) === 1);

  // Self-cleanup: this is the test removing the one row IT created in
  // this run, the same way the app's own delete button would -- not a
  // bulk/administrative cleanup of historical data.
  const sampleId = sampleData?.[0]?.id;
  if (sampleId) {
    const { error: cleanupSampleErr } = await supabase.from("samples").delete().eq("id", sampleId);
    check("test cleanup: sample row removed", !cleanupSampleErr, cleanupSampleErr?.message);
  }
  const { error: cleanupSiErr } = await supabase.from("starting_info").delete().eq("id", startingInfoId);
  check("test cleanup: starting_info (+ cascaded stone) removed", !cleanupSiErr, cleanupSiErr?.message);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Unexpected error running test:", err);
  process.exit(1);
});
