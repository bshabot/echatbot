import React from "react";

/**
 * Friendly "nothing here" block for lists and tables.
 *
 *   <EmptyState icon={Inbox} title="No samples match" hint="Try clearing a filter."
 *               action={{ label: "Clear filters", onClick: clear }} />
 *
 * Inside a <table>, wrap it:  <tr><td colSpan={n}><EmptyState .../></td></tr>
 */
export default function EmptyState({ icon: Icon, title, hint, action, className = "" }) {
  return (
    <div className={`flex flex-col items-center justify-center text-center py-12 px-4 ${className}`}>
      {Icon && (
        <div className="w-11 h-11 rounded-full bg-gray-100 flex items-center justify-center mb-3">
          <Icon className="w-5 h-5 text-gray-400" />
        </div>
      )}
      <p className="text-sm font-medium text-gray-800">{title}</p>
      {hint && <p className="text-xs text-gray-500 mt-1 max-w-sm">{hint}</p>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 px-4 py-2 rounded-lg border border-gray-300 text-[13px] text-gray-700 hover:bg-gray-50"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
