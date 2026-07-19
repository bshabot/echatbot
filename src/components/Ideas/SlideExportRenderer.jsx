import { hydrate, imgUrl, CANVAS_W, CANVAS_H } from "./SlideEditor";

// Renders one slide for PDF export exactly as it looks on the editor canvas.
// One slide per letter-portrait page (page size set in IdeasExportButton);
// the 960x540 canvas is scaled to 7.6in wide (96dpi -> 729.6px, scale 0.76).
const EXPORT_SCALE = 0.76;

export default function SlideRenderer({ slide }) {
  return (
    <div
      style={{
        width: "8in",
        height: "10.5in",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pageBreakAfter: "always",
        boxSizing: "border-box",
        background: "white",
      }}
    >
      <div
        style={{
          width: CANVAS_W * EXPORT_SCALE,
          height: CANVAS_H * EXPORT_SCALE,
          position: "relative",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: CANVAS_W,
            height: CANVAS_H,
            transform: `scale(${EXPORT_SCALE})`,
            transformOrigin: "top left",
            position: "absolute",
            background: "white",
            border: "1px solid #e5e7eb",
            overflow: "hidden",
          }}
        >
          {(slide.elements || []).map((raw) => {
            const el = hydrate(raw);
            return el.type === "image" ? (
              <img
                key={el.id}
                src={imgUrl(el.src)}
                alt={el.content || ""}
                style={{
                  position: "absolute",
                  left: el.left,
                  top: el.top,
                  width: el.width,
                  height: el.height,
                  objectFit: "cover",
                }}
              />
            ) : (
              <div
                key={el.id}
                style={{
                  position: "absolute",
                  left: el.left,
                  top: el.top,
                  width: el.width,
                  fontSize: el.fontSize,
                  fontWeight: el.bold ? 600 : 400,
                  fontStyle: el.italic ? "italic" : "normal",
                  color: el.color,
                  textAlign: el.align,
                  whiteSpace: "pre-wrap",
                  lineHeight: 1.3,
                  padding: 2,
                }}
              >
                {el.content}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
