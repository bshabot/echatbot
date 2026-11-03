import { useRef, useState } from "react";
import { portal } from "./api.js";
import { CAD_ACCEPT, CAD_EXTENSIONS, MAX_FILE_BYTES, MAX_FILES } from "./fields.js";

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const extOf = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");

// Straight to private storage with a one-time URL from the server. The page never holds a storage key.
function putFile(url, file, onProgress) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => resolve(xhr.status >= 200 && xhr.status < 300);
    xhr.onerror = () => resolve(false);
    xhr.ontimeout = () => resolve(false);
    const fd = new FormData();
    fd.append("cacheControl", "3600");
    fd.append("", file);
    xhr.send(fd);
  });
}

let seq = 0;

// `files` entries: { key, id?, name, size, status: "uploading" | "done" | "error", progress?, error?, attached? }
// `setFiles(fn)` takes an updater so parallel uploads never overwrite each other.
export default function CadFiles({ files = [], setFiles, onSessionLost }) {
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState(null);
  const input = useRef(null);

  const patch = (key, changes) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...changes } : f)));

  async function upload(file, key) {
    const begin = await portal("fileBegin", { name: file.name, size: file.size });
    if (begin.status === 401) return onSessionLost?.();
    if (!begin.ok) return patch(key, { status: "error", error: begin.message || "Could not start the upload." });
    const ok = await putFile(begin.uploadUrl, file, (p) => patch(key, { progress: p }));
    if (!ok) {
      portal("fileRemove", { id: begin.id });
      return patch(key, { status: "error", error: "Upload failed. Check your connection and try again." });
    }
    const done = await portal("fileDone", { id: begin.id });
    if (done.status === 401) return onSessionLost?.();
    if (!done.ok) return patch(key, { status: "error", error: done.message || "The upload did not finish. Try again." });
    patch(key, { id: begin.id, status: "done", progress: 100 });
  }

  function add(list) {
    setNote(null);
    const picked = Array.from(list || []);
    if (!picked.length) return;
    const room = MAX_FILES - files.filter((f) => f.status !== "error").length;
    const problems = [];
    const accepted = [];
    for (const f of picked) {
      if (!CAD_EXTENSIONS.includes(extOf(f.name))) problems.push(`${f.name}: file type not allowed`);
      else if (f.size < 1) problems.push(`${f.name}: file is empty`);
      else if (f.size > MAX_FILE_BYTES) problems.push(`${f.name}: larger than 100 MB`);
      else if (accepted.length >= room) problems.push(`${f.name}: only ${MAX_FILES} files per item`);
      else accepted.push(f);
    }
    if (problems.length) setNote(problems.join(". "));
    const entries = accepted.map((f) => ({ key: `u${++seq}`, name: f.name, size: f.size, status: "uploading", progress: 0, file: f }));
    if (!entries.length) return;
    setFiles((fs) => [...fs, ...entries.map(({ file, ...e }) => e)]);
    entries.forEach((e) => upload(e.file, e.key));
  }

  const remove = async (f) => {
    setFiles((fs) => fs.filter((x) => x.key !== f.key));
    // A file already attached to a saved item is detached when the item is saved; a fresh upload is deleted now.
    if (f.status === "done" && f.id && !f.attached) {
      const res = await portal("fileRemove", { id: f.id });
      if (res.status === 401) onSessionLost?.();
    }
  };

  const full = files.filter((f) => f.status !== "error").length >= MAX_FILES;

  return (
    <div className="space-y-2">
      {!full && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            add(e.dataTransfer.files);
          }}
          className={`rounded-lg border-2 border-dashed p-4 text-center text-sm ${dragging ? "border-chabot-gold bg-yellow-50" : "border-gray-300 bg-gray-50"}`}
        >
          <p className="text-gray-700">
            Drop CAD files or pictures here, or{" "}
            <button type="button" className="text-chabot-gold underline" onClick={() => input.current?.click()}>
              choose files
            </button>
          </p>
          <p className="text-xs text-gray-500 mt-1">Up to {MAX_FILES} files, 100 MB each. Pictures, PDF, DWG, DXF, STEP, STL, IGES, 3DM.</p>
          <input ref={input} type="file" multiple accept={CAD_ACCEPT} className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ""; }} />
        </div>
      )}
      {note && <p className="text-xs text-red-600">{note}</p>}
      {files.length > 0 && (
        <ul className="space-y-2">
          {files.map((f) => (
            <li key={f.key} className="flex items-center gap-3 rounded-lg border bg-white px-3 py-2 text-sm">
              <span className="shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-xs font-medium uppercase text-gray-600">{extOf(f.name) || "file"}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-gray-800">{f.name}</div>
                {f.status === "uploading" ? (
                  <div className="mt-1 h-1.5 w-full rounded bg-gray-200">
                    <div className="h-1.5 rounded bg-chabot-gold" style={{ width: `${f.progress || 0}%` }} />
                  </div>
                ) : f.status === "error" ? (
                  <div className="text-xs text-red-600">{f.error}</div>
                ) : (
                  <div className="text-xs text-gray-500">{fmtSize(f.size)} · uploaded</div>
                )}
              </div>
              {f.status !== "uploading" && (
                <button type="button" className="text-sm text-red-600" onClick={() => remove(f)}>
                  {f.status === "error" ? "Dismiss" : "Remove"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
