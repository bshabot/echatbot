import { useSearchParams } from "react-router-dom";
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

// Compact shared pager (Samples / Ideas / Designs / Quotes grid).
// Arrows + editable "Page N" box (debounced jump-to-page). Page is 1-based in
// the UI, 0-based in the URL param.
// When `totalPages` is passed (from a count:"exact" fetch) the pager shows
// "of M", clamps typed jumps, and hard-stops at the last page; otherwise it
// falls back to the hasMore behavior.
export default function Pagination({ loading, hasMore, totalPages, children }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const page = parseInt(searchParams.get("page") || "0", 10);
  const [inputPage, setInputPage] = useState(String(page + 1));
  const known = Number.isFinite(totalPages) && totalPages > 0;

  // Keep the box in sync when the page changes via the arrows.
  useEffect(() => {
    setInputPage(String(page + 1));
  }, [page]);

  // Debounced jump-to-page for a number typed into the box (clamped to the
  // real page range when we know it).
  useEffect(() => {
    const t = setTimeout(() => {
      let parsed = parseInt(inputPage, 10);
      if (isNaN(parsed)) return;
      if (parsed < 1) parsed = 1;
      if (known && parsed > totalPages) parsed = totalPages;
      if (parsed - 1 !== page) handlePageChange(parsed - 1);
      else setInputPage(String(page + 1)); // snap the box back to a valid value
    }, 600);
    return () => clearTimeout(t);
  }, [inputPage]);

  const handlePageChange = (newPage) => {
    if (newPage < 0) return;
    if (known ? newPage >= totalPages : newPage > page && !hasMore) return;
    const newParams = new URLSearchParams(searchParams);
    newParams.set("page", newPage);
    setSearchParams(newParams);
  };

  const nextDisabled = loading || (known ? page + 1 >= totalPages : !hasMore);

  const btn =
    "p-1.5 rounded-md text-gray-600 hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent";

  return (
    <div>
      {children}
      {/* sticky: floats at the viewport bottom while the list is taller than
          the screen, settles into place at the end — no scrolling to find it */}
      <div className="sticky bottom-2 flex justify-center py-3 pointer-events-none">
        <nav className="pointer-events-auto inline-flex items-center gap-1 bg-white border border-gray-200 rounded-lg shadow-md px-1.5 py-1 text-sm select-none">
          <button
            type="button"
            className={btn}
            onClick={() => handlePageChange(page - 1)}
            disabled={page === 0 || loading}
            aria-label="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="flex items-center gap-1.5 px-1 text-gray-600">
            Page
            <input
              inputMode="numeric"
              value={inputPage}
              onChange={(e) => setInputPage(e.target.value.replace(/[^0-9]/g, ""))}
              className="w-10 text-center border border-gray-200 rounded-md py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              aria-label="Page number"
            />
            {known && <span className="whitespace-nowrap">of {totalPages}</span>}
          </span>
          <button
            type="button"
            className={btn}
            onClick={() => handlePageChange(page + 1)}
            disabled={nextDisabled}
            aria-label="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </nav>
      </div>
    </div>
  );
}
