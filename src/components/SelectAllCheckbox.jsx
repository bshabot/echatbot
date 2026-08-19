// src/components/SelectAllCheckbox.jsx
//
// The header "select all" checkbox for every table with row selection.
//
// Three states, which is what a header checkbox actually needs:
//   unchecked      nothing on this page is selected
//   indeterminate  SOME rows are selected (the dash, not a tick)
//   checked        every row on this page is selected
//
// Clicking is deliberately two-state, and this is the part that was wrong in
// several tables: from EITHER unchecked or indeterminate a click selects
// everything; only from fully-checked does it clear. So a partial selection
// takes two clicks to get to empty (all, then none) and never leaves you
// guessing what a click will do. The alternative — partial clearing straight
// to empty — silently throws away a selection someone built by hand.
//
// `indeterminate` is a DOM property, not an HTML attribute: React can't set
// it through JSX, so it has to be assigned on the element. That's why this
// is a component rather than a copied `<input>` — every table that hand-
// rolled one either forgot the property (no dash for partial selections) or
// got `checked` wrong on an empty list (`0 === 0` reads as "all selected",
// showing a tick over an empty table).
//
// Props:
//   total     rows currently selectable (the FILTERED/visible set, not the
//             whole dataset — "select all" should mean what's on screen)
//   selected  how many of those are selected
//   onToggle(nextChecked)  true = select them all, false = clear them

import { useEffect, useRef } from "react";

export default function SelectAllCheckbox({
  total = 0,
  selected = 0,
  onToggle,
  className = "",
  title,
}) {
  const ref = useRef(null);
  const all = total > 0 && selected >= total;
  const some = selected > 0 && selected < total;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = some;
  }, [some]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      disabled={total === 0}
      onChange={() => onToggle?.(!all)}
      className={`cursor-pointer align-middle disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      title={
        title ??
        (all
          ? `Clear all ${total}`
          : some
            ? `${selected} of ${total} selected — select all`
            : `Select all ${total}`)
      }
      aria-label="Select all rows"
      aria-checked={some ? "mixed" : all}
    />
  );
}
