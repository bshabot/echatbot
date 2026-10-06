import React, { useEffect, useRef, useState } from "react";

// Shared building blocks for the long modal forms (Add / Edit Sample, ...):
// white section cards on a grey body, a jump bar that sits above the
// scrolling area (so it never covers fields), and the status pills.
//
//   <SectionNav sections={SECTIONS} scrollId="x-scroll" prefix="x" requiredLeft={n} />
//   <div id="x-scroll" className="flex-1 min-h-0 overflow-y-auto p-6 bg-gray-50"> ...
//     <SectionCard prefix="x" id="basics" title="Basics" hint="...">fields</SectionCard>

export function SectionCard({ prefix = "sec", id, title, hint, children }) {
  return (
    <section
      id={`${prefix}-sec-${id}`}
      data-form-sec={id}
      data-form-sec-prefix={prefix}
      className="scroll-mt-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm space-y-5 [&_label]:text-sm [&_label]:font-medium [&_label]:text-gray-700"
    >
      <header>
        <h3 className="text-[15px] font-semibold text-gray-900">{title}</h3>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </header>
      {children}
    </section>
  );
}

export function SectionNav({ sections, scrollId, prefix = "sec", requiredLeft = null }) {
  const [active, setActive] = useState(sections[0]?.id);
  const barRef = useRef(null);

  useEffect(() => {
    const root = document.getElementById(scrollId);
    if (!root) return undefined;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 60;
      let current = sections[0]?.id;
      root.querySelectorAll(`[data-form-sec-prefix="${prefix}"]`).forEach((el) => {
        if (el.getBoundingClientRect().top <= top) current = el.dataset.formSec;
      });
      setActive(current);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => root.removeEventListener("scroll", onScroll);
  }, [scrollId, prefix, sections]);

  const jump = (id) => {
    const root = document.getElementById(scrollId);
    const el = document.getElementById(`${prefix}-sec-${id}`);
    if (!root || !el) return;
    // Scroll only the form body (never the page behind the modal).
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 16;
    root.scrollTo({ top, behavior: "smooth" });
  };

  return (
    <div
      ref={barRef}
      className="shrink-0 px-6 max-md:px-3 py-2.5 bg-white border-b border-gray-200 flex items-center gap-2"
    >
      <div className="flex gap-1 overflow-x-auto flex-1">
        {sections.map((sec) => (
          <button
            key={sec.id}
            type="button"
            onClick={() => jump(sec.id)}
            className={`px-3 py-1 text-[13px] rounded-full whitespace-nowrap transition-colors ${
              active === sec.id ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-100"
            }`}
          >
            {sec.label}
          </button>
        ))}
      </div>
      {requiredLeft != null && (
        <span
          className={`shrink-0 text-xs font-medium px-2.5 py-1 rounded-full ${
            requiredLeft > 0 ? "bg-[#C5A572]/15 text-[#8a6d3b]" : "bg-green-100 text-green-700"
          }`}
        >
          {requiredLeft > 0 ? `${requiredLeft} required left` : "Required fields done"}
        </span>
      )}
    </div>
  );
}

const STATUS_OPTIONS = [
  { value: "Working_on_it:yellow", label: "Working on it", dot: "bg-yellow-500", on: "border-yellow-500 bg-yellow-50 text-yellow-900" },
  { value: "Quote_created:blue", label: "Quote created", dot: "bg-blue-500", on: "border-blue-500 bg-blue-50 text-blue-900" },
  { value: "Running_line:green", label: "Running line", dot: "bg-green-500", on: "border-green-500 bg-green-50 text-green-900" },
  { value: "Dead:red", label: "Dead", dot: "bg-red-500", on: "border-red-500 bg-red-50 text-red-900" },
];

export const DESIGN_STATUS_OPTIONS = [
  { value: "Working_On_It:yellow", label: "Working on it", dot: "bg-yellow-500", on: "border-yellow-500 bg-yellow-50 text-yellow-900" },
  { value: "Waiting_On_Cads:grey", label: "Waiting on cads", dot: "bg-gray-500", on: "border-gray-500 bg-gray-100 text-gray-900" },
  { value: "Sample_Created:green", label: "Sample created", dot: "bg-green-500", on: "border-green-500 bg-green-50 text-green-900" },
  { value: "Received_Quote:blue", label: "Received quote", dot: "bg-blue-500", on: "border-blue-500 bg-blue-50 text-blue-900" },
  { value: "Dead:red", label: "Dead", dot: "bg-red-500", on: "border-red-500 bg-red-50 text-red-900" },
];

export function StatusPills({ value, onChange, options = STATUS_OPTIONS }) {
  return (
    <div>
      <label>Status</label>
      <div role="radiogroup" aria-label="Status" className="mt-1 flex flex-wrap gap-2">
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o.value)}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-[13px] font-medium transition-colors ${
                active ? o.on : "border-gray-300 bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${o.dot}`} />
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
