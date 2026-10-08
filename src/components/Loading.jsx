import React from "react";

// Spinner + label. Default stays compact and inline; pass `fill` for a
// centered, page-sized version.
const Loading = ({ label = "Loading…", fill = false }) => (
  <div
    role="status"
    className={`flex items-center justify-center gap-2 text-sm text-gray-500 ${
      fill ? "py-24" : "py-3"
    }`}
  >
    <span className="w-4 h-4 rounded-full border-2 border-gray-300 border-t-[#C5A572] animate-spin" />
    {label}
  </div>
);

export default Loading;
