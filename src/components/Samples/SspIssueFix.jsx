import { Wrench, ExternalLink } from "lucide-react";
import { classifySspIssue, SSP_SECTION_LABELS } from "../../utils/sspIssues";

// "Fix" shortcut shown next to an SSP warning or failure. Opens the sample's
// edit modal with the message as a banner and scrolled to the section that
// holds the field. `onOpen(issue)` does the actual opening.
export default function SspIssueFix({ text, onOpen, className = "" }) {
  if (!onOpen) return null;
  const issue = classifySspIssue(text);
  return (
    <span className={`inline-flex items-center gap-2 align-middle ${className}`}>
      <button
        type="button"
        onClick={() => onOpen(issue)}
        className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-md border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
        title={`Open this sample at ${SSP_SECTION_LABELS[issue.section] || "Basics"}`}
      >
        <Wrench className="w-3 h-3" />
        Fix · {SSP_SECTION_LABELS[issue.section] || "Basics"}
      </button>
      {issue.settings && (
        <a
          href="/settings"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
        >
          Settings <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </span>
  );
}
