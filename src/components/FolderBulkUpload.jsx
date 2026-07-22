import React, { useState, useRef } from "react";
import { useSupabase } from "./SupaBaseProvider";
import { uploadImageToR2 } from "../utils/r2Upload";

export default function FolderBulkUpload({
  entity = "starting_info",
  type = "image",
  bucket = "echatbot",
  concurrency = 5,
  onComplete,
}) {
  const { supabase } = useSupabase();
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState({});
  const [pendingGrouped, setPendingGrouped] = useState(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [totalFiles, setTotalFiles] = useState(0);
  const [completedFiles, setCompletedFiles] = useState(0);
  const [duplicateFiles, setDuplicateFiles] = useState([]);
  const [emptyFiles, setEmptyFiles] = useState([]);
  const [checking, setChecking] = useState(false);
  const [checkProgress, setCheckProgress] = useState({ scanned: 0, total: null });
  const [uploadResult, setUploadResult] = useState(null);
  const inputRef = useRef(null);

  async function findSampleId(folderName) {
    const { data } = await supabase
      .from("samples")
      .select("id, starting_info_id")
      .eq("styleNumber", folderName)
      .limit(1)
      .maybeSingle();
    return data?.starting_info_id ?? null;
  }

  // Duplicate check against the images table — the source of truth for what's
  // already been uploaded. Blobs now live in R2 (written by the r2-upload
  // function), not Supabase storage, so we match on the imageUrl path instead
  // of listing a bucket.
  async function checkDuplicates(files) {
    const dests = files.map((f) => `public/${f.name.replace(/\s+/g, "_")}`);
    setCheckProgress({ scanned: 0, total: dests.length });
    const existing = new Set();
    const CHUNK = 200;
    for (let i = 0; i < dests.length; i += CHUNK) {
      const slice = dests.slice(i, i + CHUNK);
      const { data } = await supabase
        .from("images")
        .select("imageUrl")
        .in("imageUrl", slice);
      (data || []).forEach((r) => existing.add(r.imageUrl));
      setCheckProgress((p) => ({ ...p, scanned: Math.min(i + CHUNK, dests.length) }));
    }
    return files
      .map((f) => f.name.replace(/\s+/g, "_"))
      .filter((name) => existing.has(`public/${name}`));
  }

  const handleFiles = async (e) => {
    const raw = Array.from(e.target.files || []);
    if (raw.length === 0) return;

    const empty = raw.filter((f) => f.size === 0);
    const validFiles = raw.filter((f) => f.size > 0);
    setEmptyFiles(empty.map((f) => f.name));

    const grouped = validFiles.reduce((acc, f) => {
      const rel = f.webkitRelativePath || f.name;
      const parts = rel.split("/").filter(Boolean);
      let style = parts.length >= 2 ? parts[1] : parts[0];
      style = style || "unknown";
      acc[style] = acc[style] || [];
      acc[style].push(f);
      return acc;
    }, {});

    setChecking(true);
    const dupes = await checkDuplicates(validFiles);
    setChecking(false);

    setDuplicateFiles(dupes);
    setPendingGrouped(grouped);
    setShowConfirm(true);
  };

  const startUpload = async (replaceExisting = false) => {
    if (!pendingGrouped) return;
    setShowConfirm(false);
    setUploading(true);
    setUploadResult(null);

    const grouped = pendingGrouped;
    const stats = { successCount: 0, failCount: 0, skippedCount: 0, replacedCount: 0, details: [] };
    const total = Object.values(grouped).reduce((acc, arr) => acc + arr.length, 0);
    setTotalFiles(total);
    setCompletedFiles(0);

    const progInit = {};
    Object.keys(grouped).forEach((s) => {
      progInit[s] = { total: grouped[s].length, done: 0, errors: [], skipped: 0 };
    });
    setProgress(progInit);

    const sampleIdMap = {};
    await Promise.all(
      Object.keys(grouped).map(async (style) => {
        sampleIdMap[style] = await findSampleId(style);
      })
    );

    const dupeSet = new Set(duplicateFiles);
    const allTasks = Object.entries(grouped).flatMap(([style, fls]) =>
      fls.map((file) => ({ style, file }))
    );

    let idx = 0;
    const workers = Array.from(
      { length: Math.max(1, Math.min(concurrency, allTasks.length)) },
      async () => {
        while (true) {
          const i = idx++;
          if (i >= allTasks.length) break;
          const { style, file } = allTasks[i];
          const filename = file.name.replace(/\s+/g, "_");
          const dest = `public/${filename}`;
          const isDupe = dupeSet.has(filename);

          try {
            if (isDupe && !replaceExisting) {
              stats.skippedCount++;
              stats.details.push({ style, file: filename, ok: true, skipped: true });
              setProgress((p) => {
                const cur = { ...(p[style] || { total: 0, done: 0, errors: [], skipped: 0 }) };
                cur.skipped = (cur.skipped || 0) + 1;
                cur.done = (cur.done || 0) + 1;
                return { ...p, [style]: cur };
              });
            } else {
              await uploadImageToR2(supabase, dest, file);

              const { data: imgData, error: insertErr } = await supabase
                .from("images")
                .insert([{ imageUrl: dest, originalUrl: dest }])
                .select("id, imageUrl")
                .single();
              if (insertErr) throw insertErr;

              const entityId = sampleIdMap[style] ?? style;
              const { error: linkErr } = await supabase.from("image_link").insert([{
                imageId: imgData.id,
                styleNumber: style,
                entity,
                entityId,
                type,
              }]);
              if (linkErr) throw linkErr;

              if (isDupe) stats.replacedCount++;
              else stats.successCount++;
              stats.details.push({ style, file: filename, ok: true, replaced: isDupe });

              setProgress((p) => {
                const cur = { ...(p[style] || { total: 0, done: 0, errors: [], skipped: 0 }) };
                cur.done = (cur.done || 0) + 1;
                return { ...p, [style]: cur };
              });
            }
          } catch (err) {
            stats.failCount++;
            stats.details.push({ style, file: file.name, ok: false, error: err?.message || err });
            setProgress((p) => {
              const cur = { ...(p[style] || { total: 0, done: 0, errors: [], skipped: 0 }) };
              cur.errors = [...(cur.errors || []), file.name];
              cur.done = (cur.done || 0) + 1;
              return { ...p, [style]: cur };
            });
          } finally {
            setCompletedFiles((prev) => prev + 1);
          }
        }
      }
    );

    await Promise.all(workers);
    setUploading(false);
    setPendingGrouped(null);
    setDuplicateFiles([]);
    setEmptyFiles([]);
    setUploadResult(stats);
    onComplete?.(stats);
  };

  const handleCancel = () => {
    setPendingGrouped(null);
    setShowConfirm(false);
    setProgress({});
    setDuplicateFiles([]);
    setEmptyFiles([]);
    setTotalFiles(0);
    setCompletedFiles(0);
    setUploadResult(null);
    if (inputRef.current) inputRef.current.value = null;
  };

  const progressPercent =
    totalFiles > 0 ? Math.round((completedFiles / totalFiles) * 100) : 0;

  const totalFileCount = pendingGrouped
    ? Object.values(pendingGrouped).reduce((acc, arr) => acc + arr.length, 0)
    : 0;
  const newFileCount = totalFileCount - duplicateFiles.length;

  return (
    <div className="space-y-4">
      {/* File input */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Select folder to upload
        </label>
        <input
          ref={inputRef}
          type="file"
          webkitdirectory="true"
          directory="true"
          multiple={false}
          onChange={handleFiles}
          className="block w-full text-sm text-gray-900 border border-gray-300 rounded-lg cursor-pointer bg-gray-50 focus:outline-none hover:bg-gray-100 p-2"
        />
      </div>

      {/* Checking spinner with paginated scan progress */}
      {checking && (
        <div className="p-5 border rounded-xl bg-white border-gray-200 shadow-sm space-y-3">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 animate-spin text-blue-500 shrink-0" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
            </svg>
            <div>
              <p className="text-sm font-semibold text-gray-800">Scanning storage for duplicates…</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {checkProgress.scanned.toLocaleString()} files scanned
                {checkProgress.total ? ` of ~${checkProgress.total.toLocaleString()}` : ""}
              </p>
            </div>
          </div>
          <div className="w-full bg-gray-100 rounded-full h-1.5 overflow-hidden">
            <div className="h-full bg-blue-400 animate-pulse rounded-full" style={{ width: "100%" }} />
          </div>
        </div>
      )}

      {/* Confirmation panel */}
      {showConfirm && !checking && (
        <div className="border-2 rounded-xl border-blue-200 bg-white shadow-sm overflow-hidden">
          {/* Header */}
          <div className="bg-blue-50 px-6 py-4 border-b border-blue-100">
            <h4 className="font-bold text-lg text-gray-800">Ready to upload</h4>
            <p className="text-sm text-gray-500 mt-0.5">Review before continuing</p>
          </div>

          <div className="p-6 space-y-4">
            {/* Summary stats */}
            <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
              <div className="text-center p-3 bg-blue-50 rounded-xl border border-blue-100">
                <div className="text-2xl font-bold text-blue-700">{totalFileCount}</div>
                <div className="text-xs text-gray-500 mt-1">Total selected</div>
              </div>
              <div className="text-center p-3 bg-green-50 rounded-xl border border-green-100">
                <div className="text-2xl font-bold text-green-700">{newFileCount}</div>
                <div className="text-xs text-gray-500 mt-1">New files</div>
              </div>
              <div className="text-center p-3 bg-amber-50 rounded-xl border border-amber-100">
                <div className="text-2xl font-bold text-amber-700">{duplicateFiles.length}</div>
                <div className="text-xs text-gray-500 mt-1">Already exist</div>
              </div>
              <div className="text-center p-3 bg-red-50 rounded-xl border border-red-100">
                <div className="text-2xl font-bold text-red-600">{emptyFiles.length}</div>
                <div className="text-xs text-gray-500 mt-1">Empty / invalid</div>
              </div>
            </div>

            {/* Empty files detail */}
            {emptyFiles.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm font-semibold text-red-700 mb-1">
                  ⚠️ {emptyFiles.length} empty file{emptyFiles.length !== 1 ? "s" : ""} will be skipped
                </p>
                <div className="text-xs text-red-400 max-h-16 overflow-auto leading-relaxed">
                  {emptyFiles.join(", ")}
                </div>
              </div>
            )}

            {/* Duplicate files detail */}
            {duplicateFiles.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
                <p className="text-sm font-semibold text-amber-800 mb-1">
                  {duplicateFiles.length} file{duplicateFiles.length !== 1 ? "s" : ""} already exist in storage
                </p>
                <div className="text-xs text-amber-600 max-h-16 overflow-auto leading-relaxed mb-3">
                  {duplicateFiles.join(", ")}
                </div>
                <div className="flex gap-2">
                  <button
                    className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-600 text-white rounded-lg text-sm font-semibold transition-all"
                    onClick={() => startUpload(true)}
                  >
                    Replace + upload all
                  </button>
                  <button
                    className="flex-1 py-2.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-semibold transition-all"
                    onClick={() => startUpload(false)}
                  >
                    Skip existing, new only
                  </button>
                </div>
              </div>
            )}

            {/* No dupes — simple confirm */}
            {duplicateFiles.length === 0 && totalFileCount > 0 && (
              <button
                className="w-full py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition-all flex items-center justify-center gap-2"
                onClick={() => startUpload(false)}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
                </svg>
                Upload {totalFileCount} file{totalFileCount !== 1 ? "s" : ""}
              </button>
            )}

            {totalFileCount === 0 && (
              <p className="text-sm text-gray-500 text-center py-2">No valid files to upload.</p>
            )}

            <button
              className="w-full py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg text-sm font-medium transition-all"
              onClick={handleCancel}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Upload progress */}
      {uploading && (
        <div className="border-2 rounded-xl border-gray-200 bg-white shadow-sm overflow-hidden">
          <div className="bg-gray-50 px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <div>
              <h4 className="font-bold text-lg text-gray-800">Uploading</h4>
              <p className="text-xs text-gray-500 mt-0.5">{completedFiles} of {totalFiles} files</p>
            </div>
            <span className="text-3xl font-bold text-blue-600">{progressPercent}%</span>
          </div>

          <div className="px-6 pt-4 pb-2">
            <div className="w-full bg-gray-100 rounded-full h-3 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 transition-all duration-300 rounded-full"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>

          <div className="p-4 space-y-2 max-h-72 overflow-auto">
            {Object.entries(progress).map(([style, s]) => {
              const pct = s.total > 0 ? Math.round((s.done / s.total) * 100) : 0;
              const done = s.done >= s.total;
              return (
                <div
                  key={style}
                  className={`rounded-lg p-3 border transition-colors ${
                    done ? "bg-green-50 border-green-200" : "bg-gray-50 border-gray-200"
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      {done ? (
                        <svg className="w-4 h-4 text-green-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/>
                        </svg>
                      ) : (
                        <svg className="w-4 h-4 animate-spin text-blue-400 shrink-0" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                        </svg>
                      )}
                      <span className="text-sm font-semibold text-gray-700">{style}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {s.skipped > 0 && (
                        <span className="text-xs text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                          {s.skipped} skipped
                        </span>
                      )}
                      {s.errors?.length > 0 && (
                        <span className="text-xs text-red-600 bg-red-50 px-1.5 py-0.5 rounded">
                          {s.errors.length} failed
                        </span>
                      )}
                      <span className="text-xs text-gray-500">{s.done}/{s.total}</span>
                    </div>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5 overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 rounded-full ${
                        done ? "bg-green-500" : "bg-blue-500"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Completion summary */}
      {uploadResult && !uploading && (
        <div className="border-2 rounded-xl border-green-200 bg-white shadow-sm overflow-hidden">
          <div className="bg-green-50 px-6 py-4 border-b border-green-100 flex items-center gap-3">
            <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
            <div>
              <h4 className="font-bold text-lg text-gray-800">Upload complete</h4>
              <p className="text-xs text-gray-500">All tasks finished</p>
            </div>
          </div>
          <div className="p-6 grid grid-cols-4 gap-3 max-md:grid-cols-2">
            <div className="text-center p-3 bg-green-50 rounded-xl border border-green-100">
              <div className="text-2xl font-bold text-green-700">{uploadResult.successCount}</div>
              <div className="text-xs text-gray-500 mt-1">Uploaded</div>
            </div>
            <div className="text-center p-3 bg-blue-50 rounded-xl border border-blue-100">
              <div className="text-2xl font-bold text-blue-700">{uploadResult.replacedCount}</div>
              <div className="text-xs text-gray-500 mt-1">Replaced</div>
            </div>
            <div className="text-center p-3 bg-amber-50 rounded-xl border border-amber-100">
              <div className="text-2xl font-bold text-amber-700">{uploadResult.skippedCount}</div>
              <div className="text-xs text-gray-500 mt-1">Skipped</div>
            </div>
            <div className="text-center p-3 bg-red-50 rounded-xl border border-red-100">
              <div className="text-2xl font-bold text-red-600">{uploadResult.failCount}</div>
              <div className="text-xs text-gray-500 mt-1">Failed</div>
            </div>
          </div>
          {uploadResult.failCount > 0 && (
            <div className="px-6 pb-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600 max-h-24 overflow-auto">
                <p className="font-semibold text-red-700 mb-1">Failed files:</p>
                {uploadResult.details
                  .filter((d) => !d.ok)
                  .map((d, i) => (
                    <div key={i}>{d.file} — {d.error}</div>
                  ))}
              </div>
            </div>
          )}
          <div className="px-6 pb-5">
            <button
              className="w-full py-2.5 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg text-sm font-medium transition-all"
              onClick={handleCancel}
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}