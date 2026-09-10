// src/components/SspCreateProgress.jsx
//
// Ring around the sample-card kebab (⋯) button showing "Create in SSP"
// progress. One continuous ring fills more green as sendPreparedSspCreates
// works through this item's applicable steps (header -> item -> [material]
// -> [finding] -> [labor] -- only the ones this item actually has). No
// separate arc segments/gaps: just more of the circumference turning
// green, per spec. Turns red and stops growing at whichever step fails.
//
// Fed by the onProgress callback sendPreparedSspCreates emits:
// { index, total, label, steps, step, status, error }. SampleList.jsx
// collects these per-sample into a `{ steps, statusByStep }` map and
// passes the relevant entry down as the `progress` prop here.

const RADIUS = 15;
const CIRC = 2 * Math.PI * RADIUS;

const COLOR = {
  active: "#f59e0b", // amber-500 -- matches the app's other in-flight states
  success: "#22c55e", // green-500
  error: "#ef4444", // red-500
};

export default function SspCreateProgress({ progress, size = 36 }) {
  if (!progress || !progress.steps?.length) return null;

  const { steps, statusByStep = {} } = progress;
  const n = steps.length;
  const doneCount = steps.filter((s) => statusByStep[s] === "success").length;
  const activeIdx = steps.findIndex((s) => statusByStep[s] === "active");
  const erroredIdx = steps.findIndex((s) => statusByStep[s] === "error");

  let fraction;
  let color;
  if (erroredIdx !== -1) {
    // Filled through the failed step, then stops -- later steps (if any
    // still ran, e.g. finding/labor failures don't abort the item) don't
    // grow the ring further once something has gone wrong.
    fraction = Math.max((erroredIdx + 1) / n, doneCount / n);
    color = COLOR.error;
  } else {
    fraction = doneCount / n;
    if (activeIdx !== -1) fraction += 0.5 / n; // creeps forward mid-step
    color = doneCount === n ? COLOR.success : COLOR.active;
  }
  if (fraction <= 0) return null;

  const c = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="absolute inset-0 pointer-events-none"
      style={{ transform: "rotate(-90deg)" }}
      aria-hidden="true"
    >
      <circle cx={c} cy={c} r={RADIUS} fill="none" stroke="#e5e7eb" strokeWidth={2.5} />
      <circle
        cx={c}
        cy={c}
        r={RADIUS}
        fill="none"
        strokeWidth={2.5}
        strokeLinecap="round"
        stroke={color}
        strokeDasharray={`${CIRC} ${CIRC}`}
        strokeDashoffset={CIRC * (1 - fraction)}
        style={{ transition: "stroke-dashoffset 0.5s ease, stroke 0.25s ease" }}
      />
    </svg>
  );
}
