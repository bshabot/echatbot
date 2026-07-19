import React, { useState, useEffect, useRef, useCallback } from "react";
import { useSupabase } from "../SupaBaseProvider";
import { v4 as uuidv4 } from "uuid";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Copy,
  ImagePlus,
  Italic,
  Trash2,
  Type,
} from "lucide-react";

// ----- canvas geometry: slides live in a fixed 960x540 (16:9) space -----
const CANVAS_W = 960;
const CANVAS_H = 540;

const TEXT_DEFAULTS = { width: 240, fontSize: 20, bold: false, italic: false, color: "#1f2937", align: "left" };
const IMG_DEFAULT = 250;
const COLORS = ["#1f2937", "#6b7280", "#ffffff", "#C5A572", "#b91c1c"];

// Legacy elements have only {left, top, content/src}. Fill in v2 fields.
const hydrate = (el) =>
  el.type === "image"
    ? { width: IMG_DEFAULT, height: IMG_DEFAULT, z: 1, ...el }
    : { ...TEXT_DEFAULTS, z: 2, ...el };

// Legacy image srcs are sometimes full URLs, sometimes bucket paths.
const imgUrl = (src) =>
  src?.startsWith("http") ? src : `${process.env.VITE_DB_HOST_URL}${src}`;

function SlideEditorWrapper({ onSave, initialData, setIdeaForm, readOnly = false, onExport, stageHeight }) {
  const [slides, setSlides] = useState([]);

  useEffect(() => {
    if (setIdeaForm) setIdeaForm(slides);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides]);

  useEffect(() => {
    setSlides(initialData || []);
  }, [initialData]);

  return (
    <SlideEditor
      onSave={onSave}
      slides={slides}
      setSlides={setSlides}
      readOnly={readOnly}
      onExport={onExport}
      stageHeight={stageHeight}
    />
  );
}

// ----- one element on the canvas -----
function CanvasElement({ el, selected, scale, readOnly, onSelect, onChange, onStartEdit, editing, onEndEdit }) {
  const dragRef = useRef(null);

  const startDrag = (e, mode, corner) => {
    if (readOnly || editing) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect(el.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { left: el.left, top: el.top, width: el.width, height: el.height, fontSize: el.fontSize };

    const move = (ev) => {
      const dx = (ev.clientX - startX) / scale;
      const dy = (ev.clientY - startY) / scale;
      if (mode === "move") {
        onChange({ ...el, left: Math.round(orig.left + dx), top: Math.round(orig.top + dy) });
      } else {
        let w = orig.width;
        let h = orig.height;
        let left = orig.left;
        let top = orig.top;
        const sx = corner.includes("e") ? dx : corner.includes("w") ? -dx : 0;
        const sy = corner.includes("s") ? dy : corner.includes("n") ? -dy : 0;
        if (el.type === "image") {
          // keep aspect ratio, like PowerPoint corner resize
          const ratio = orig.height / (orig.width || 1);
          w = Math.max(30, orig.width + Math.max(sx, sy / ratio));
          h = w * ratio;
        } else {
          w = Math.max(60, orig.width + sx);
          h = orig.height ? Math.max(24, orig.height + sy) : undefined;
        }
        if (corner.includes("w")) left = orig.left + (orig.width - w);
        if (corner.includes("n") && orig.height) top = orig.top + (orig.height - h);
        onChange({ ...el, width: Math.round(w), height: h ? Math.round(h) : h, left: Math.round(left), top: Math.round(top) });
      }
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  const style = {
    position: "absolute",
    left: el.left,
    top: el.top,
    width: el.width,
    height: el.type === "image" ? el.height : el.height || "auto",
    zIndex: el.z || 1,
    cursor: readOnly ? "default" : "move",
    outline: selected && !readOnly ? "1.5px solid #C5A572" : "none",
    outlineOffset: "1px",
  };

  const handles = selected && !readOnly && !editing;
  const corners = el.type === "image" ? ["nw", "ne", "sw", "se"] : ["nw", "ne", "sw", "se", "e", "w"];
  const handlePos = {
    nw: { left: -5, top: -5, cursor: "nwse-resize" },
    ne: { right: -5, top: -5, cursor: "nesw-resize" },
    sw: { left: -5, bottom: -5, cursor: "nesw-resize" },
    se: { right: -5, bottom: -5, cursor: "nwse-resize" },
    e: { right: -5, top: "50%", marginTop: -5, cursor: "ew-resize" },
    w: { left: -5, top: "50%", marginTop: -5, cursor: "ew-resize" },
  };

  return (
    <div
      ref={dragRef}
      style={style}
      onMouseDown={(e) => startDrag(e, "move")}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!readOnly && el.type === "text") onStartEdit(el.id);
      }}
    >
      {el.type === "image" ? (
        <img
          src={imgUrl(el.src)}
          alt={el.content || ""}
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", pointerEvents: "none" }}
        />
      ) : editing ? (
        <textarea
          autoFocus
          defaultValue={el.content}
          onBlur={(e) => onEndEdit(el.id, e.target.value)}
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            width: "100%",
            minHeight: 40,
            fontSize: el.fontSize,
            fontWeight: el.bold ? 600 : 400,
            fontStyle: el.italic ? "italic" : "normal",
            color: el.color,
            textAlign: el.align,
            background: "rgba(255,255,255,0.9)",
            border: "1px dashed #C5A572",
            outline: "none",
            resize: "none",
            lineHeight: 1.3,
            padding: 2,
          }}
        />
      ) : (
        <div
          style={{
            fontSize: el.fontSize,
            fontWeight: el.bold ? 600 : 400,
            fontStyle: el.italic ? "italic" : "normal",
            color: el.color,
            textAlign: el.align,
            whiteSpace: "pre-wrap",
            lineHeight: 1.3,
            padding: 2,
            minHeight: 24,
            userSelect: "none",
          }}
        >
          {el.content}
        </div>
      )}
      {handles &&
        corners.map((c) => (
          <div
            key={c}
            onMouseDown={(e) => startDrag(e, "resize", c)}
            style={{
              position: "absolute",
              width: 10,
              height: 10,
              background: "#fff",
              border: "1.5px solid #C5A572",
              borderRadius: 2,
              zIndex: 50,
              ...handlePos[c],
            }}
          />
        ))}
    </div>
  );
}

// ----- slide thumbnail (scaled-down live render) -----
function Thumb({ slide, index, active, onClick, onDuplicate, onDelete, readOnly, onDragStart, onDragOver, onDrop }) {
  const scale = 128 / CANVAS_W;
  return (
    <div
      className={`relative group mb-2 cursor-pointer ${active ? "ring-2 ring-[#C5A572]" : "ring-1 ring-gray-300"} rounded bg-white`}
      onClick={onClick}
      draggable={!readOnly}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ width: 128, height: (CANVAS_H / CANVAS_W) * 128, overflow: "hidden", flexShrink: 0 }}
    >
      <div
        style={{
          width: CANVAS_W,
          height: CANVAS_H,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "relative",
          background: "white",
          pointerEvents: "none",
        }}
      >
        {(slide.elements || []).map((raw) => {
          const el = hydrate(raw);
          return el.type === "image" ? (
            <img
              key={el.id}
              src={imgUrl(el.src)}
              alt=""
              style={{ position: "absolute", left: el.left, top: el.top, width: el.width, height: el.height, objectFit: "cover" }}
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
                color: el.color,
                textAlign: el.align,
                whiteSpace: "pre-wrap",
                lineHeight: 1.3,
              }}
            >
              {el.content}
            </div>
          );
        })}
      </div>
      <div className="absolute bottom-0 left-0 bg-black/60 text-white text-[10px] px-1 rounded-tr">
        {index + 1}
      </div>
      {!readOnly && (
        <div className="absolute top-0 right-0 hidden group-hover:flex gap-0.5 p-0.5">
          <button
            title="Duplicate slide"
            onClick={(e) => {
              e.stopPropagation();
              onDuplicate();
            }}
            className="bg-white/90 border rounded p-0.5 hover:bg-gray-100"
          >
            <Copy className="w-3 h-3" />
          </button>
          <button
            title="Delete slide"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            className="bg-white/90 border rounded p-0.5 hover:bg-red-50"
          >
            <Trash2 className="w-3 h-3 text-red-600" />
          </button>
        </div>
      )}
    </div>
  );
}

function SlideEditor({ slides, setSlides, readOnly, onExport, stageHeight }) {
  const [currentSlideId, setCurrentSlideId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [scale, setScale] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const dragIndexRef = useRef(null);

  const { supabase } = useSupabase();
  const fileInputRef = useRef(null);
  const stageRef = useRef(null);

  useEffect(() => {
    if (!slides.length) {
      setCurrentSlideId(null);
      return;
    }
    if (!slides.some((s) => s.id === currentSlideId)) {
      setCurrentSlideId(slides[0].id);
    }
  }, [slides, currentSlideId]);

  // fit the 960x540 canvas to the available stage width
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const fit = () => {
      const pad = 48;
      const s = Math.min((el.clientWidth - pad) / CANVAS_W, (el.clientHeight - pad) / CANVAS_H);
      setScale(Math.max(0.2, Math.min(s, 1.5)));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [currentSlideId, slides.length]);

  const currentSlide = slides.find((s) => s.id === currentSlideId) || null;
  const selectedEl = currentSlide?.elements?.map(hydrate).find((e) => e.id === selectedId) || null;

  const patchSlide = useCallback(
    (slideId, fn) => {
      setSlides((prev) => prev.map((s) => (s.id === slideId ? fn(s) : s)));
    },
    [setSlides]
  );

  const updateElement = (next) => {
    patchSlide(currentSlideId, (s) => ({
      ...s,
      elements: (s.elements || []).map((e) => (e.id === next.id ? next : e)),
    }));
  };

  const deleteElement = (id) => {
    patchSlide(currentSlideId, (s) => ({
      ...s,
      elements: (s.elements || []).filter((e) => e.id !== id),
    }));
    setSelectedId(null);
  };

  // keyboard: delete + arrow nudge (ignored while typing)
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e) => {
      if (editingId || !selectedEl) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const step = e.shiftKey ? 10 : 1;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteElement(selectedEl.id);
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault();
        const d = {
          ArrowLeft: [-step, 0],
          ArrowRight: [step, 0],
          ArrowUp: [0, -step],
          ArrowDown: [0, step],
        }[e.key];
        updateElement({ ...selectedEl, left: selectedEl.left + d[0], top: selectedEl.top + d[1] });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedEl, editingId, readOnly, currentSlideId]);

  // ----- slide ops -----
  const addSlide = () => {
    const s = { id: uuidv4(), elements: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    setSlides((prev) => [...prev, s]);
    setCurrentSlideId(s.id);
  };

  const duplicateSlide = (slide) => {
    const copy = {
      ...slide,
      id: uuidv4(),
      elements: (slide.elements || []).map((e) => ({ ...e, id: uuidv4() })),
      created_at: new Date().toISOString(),
    };
    setSlides((prev) => {
      const i = prev.findIndex((s) => s.id === slide.id);
      const next = [...prev];
      next.splice(i + 1, 0, copy);
      return next;
    });
    setCurrentSlideId(copy.id);
  };

  const reorderSlides = (from, to) => {
    if (from === to || from == null || to == null) return;
    setSlides((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  // ----- element ops -----
  const addTextElement = () => {
    if (!currentSlide) return;
    const el = { id: uuidv4(), type: "text", content: "New text", left: 80, top: 80, ...TEXT_DEFAULTS, z: 2 };
    patchSlide(currentSlideId, (s) => ({ ...s, elements: [...(s.elements || []), el] }));
    setSelectedId(el.id);
    setEditingId(el.id);
  };

  const handleImageUpload = async (event) => {
    if (!currentSlide || !event.target.files?.length || !supabase) return;
    try {
      const files = Array.from(event.target.files);
      const uploaded = [];
      for (const file of files) {
        const filePath = `idea-images/${uuidv4()}-${file.name}`;
        const { error } = await supabase.storage.from("echatbot").upload(filePath, file);
        if (error) {
          console.error(`upload failed ${file.name}:`, error);
          continue;
        }
        const { data } = supabase.storage.from("echatbot").getPublicUrl(filePath);
        if (!data?.publicUrl) continue;
        uploaded.push({
          id: uuidv4(),
          type: "image",
          src: data.publicUrl,
          content: file.name,
          left: 120 + uploaded.length * 24,
          top: 100 + uploaded.length * 24,
          width: IMG_DEFAULT,
          height: IMG_DEFAULT,
          z: 1,
        });
      }
      patchSlide(currentSlideId, (s) => ({ ...s, elements: [...(s.elements || []), ...uploaded] }));
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (e) {
      console.error("image upload error", e);
    }
  };

  const toolbarBtn = (active) =>
    `p-1.5 rounded hover:bg-gray-200 ${active ? "bg-[#C5A572]/20 text-[#8a6d3b]" : "text-gray-600"}`;

  return (
    <div
      className="flex flex-col w-full min-w-0"
      style={{ height: stageHeight || "calc(100vh - 140px)", minHeight: 480 }}
    >
      {/* toolbar */}
      {!readOnly && (
        <div className="flex items-center gap-1 border-b bg-white px-2 py-1.5 rounded-t flex-wrap">
          <button onClick={addTextElement} className="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-gray-100 text-sm" title="Add a text box">
            <Type className="w-4 h-4" /> Text
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1 px-2 py-1.5 rounded hover:bg-gray-100 text-sm"
            title="Add images"
          >
            <ImagePlus className="w-4 h-4" /> Image
          </button>
          <input type="file" multiple ref={fileInputRef} onChange={handleImageUpload} accept="image/*" style={{ display: "none" }} />

          {selectedEl?.type === "text" && (
            <>
              <div className="w-px h-6 bg-gray-300 mx-1" />
              <div className="flex items-center gap-0.5">
                <button className={toolbarBtn(false)} title="Smaller" onClick={() => updateElement({ ...selectedEl, fontSize: Math.max(8, selectedEl.fontSize - 2) })}>
                  A-
                </button>
                <span className="text-xs w-6 text-center">{selectedEl.fontSize}</span>
                <button className={toolbarBtn(false)} title="Bigger" onClick={() => updateElement({ ...selectedEl, fontSize: Math.min(96, selectedEl.fontSize + 2) })}>
                  A+
                </button>
              </div>
              <button className={toolbarBtn(selectedEl.bold)} title="Bold" onClick={() => updateElement({ ...selectedEl, bold: !selectedEl.bold })}>
                <Bold className="w-4 h-4" />
              </button>
              <button className={toolbarBtn(selectedEl.italic)} title="Italic" onClick={() => updateElement({ ...selectedEl, italic: !selectedEl.italic })}>
                <Italic className="w-4 h-4" />
              </button>
              <button className={toolbarBtn(selectedEl.align === "left")} title="Align left" onClick={() => updateElement({ ...selectedEl, align: "left" })}>
                <AlignLeft className="w-4 h-4" />
              </button>
              <button className={toolbarBtn(selectedEl.align === "center")} title="Align center" onClick={() => updateElement({ ...selectedEl, align: "center" })}>
                <AlignCenter className="w-4 h-4" />
              </button>
              <button className={toolbarBtn(selectedEl.align === "right")} title="Align right" onClick={() => updateElement({ ...selectedEl, align: "right" })}>
                <AlignRight className="w-4 h-4" />
              </button>
              <div className="flex items-center gap-1 ml-1">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    title="Text color"
                    onClick={() => updateElement({ ...selectedEl, color: c })}
                    className={`w-5 h-5 rounded-full border ${selectedEl.color === c ? "ring-2 ring-[#C5A572]" : ""}`}
                    style={{ background: c }}
                  />
                ))}
              </div>
            </>
          )}
          {selectedEl && (
            <>
              <div className="w-px h-6 bg-gray-300 mx-1" />
              <button className={toolbarBtn(false)} title="Delete element (Del)" onClick={() => deleteElement(selectedEl.id)}>
                <Trash2 className="w-4 h-4 text-red-500" />
              </button>
            </>
          )}
          <span className="ml-auto text-xs text-gray-400 pr-2">
            {currentSlide ? `Slide ${slides.findIndex((s) => s.id === currentSlideId) + 1} of ${slides.length}` : ""}
          </span>
        </div>
      )}

      <div className="flex flex-1 min-h-0 bg-gray-100 rounded-b border border-t-0">
        {/* thumbnail rail */}
        <div className="w-40 border-r bg-gray-50 p-2 overflow-y-auto flex flex-col items-center">
          {slides.map((slide, i) => (
            <Thumb
              key={slide.id}
              slide={slide}
              index={i}
              active={slide.id === currentSlideId}
              readOnly={readOnly}
              onClick={() => {
                setCurrentSlideId(slide.id);
                setSelectedId(null);
                setEditingId(null);
              }}
              onDuplicate={() => duplicateSlide(slide)}
              onDelete={() => setConfirmDelete(slide.id)}
              onDragStart={() => (dragIndexRef.current = i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                reorderSlides(dragIndexRef.current, i);
                dragIndexRef.current = null;
              }}
            />
          ))}
          {!readOnly && (
            <button onClick={addSlide} className="w-32 mt-1 py-2 text-sm border-2 border-dashed border-gray-300 rounded text-gray-500 hover:border-[#C5A572] hover:text-[#8a6d3b]">
              + New slide
            </button>
          )}
        </div>

        {/* stage */}
        <div ref={stageRef} className="flex-1 flex items-center justify-center overflow-hidden relative">
          {currentSlide ? (
            <div
              style={{
                width: CANVAS_W * scale,
                height: CANVAS_H * scale,
                position: "relative",
                flexShrink: 0,
              }}
            >
              <div
                onMouseDown={() => {
                  setSelectedId(null);
                  setEditingId(null);
                }}
                style={{
                  width: CANVAS_W,
                  height: CANVAS_H,
                  transform: `scale(${scale})`,
                  transformOrigin: "top left",
                  background: "white",
                  boxShadow: "0 2px 12px rgba(0,0,0,0.15)",
                  position: "absolute",
                  overflow: "hidden",
                }}
              >
                {(currentSlide.elements || []).map((raw) => {
                  const el = hydrate(raw);
                  return (
                    <CanvasElement
                      key={el.id}
                      el={el}
                      scale={scale}
                      selected={el.id === selectedId}
                      editing={el.id === editingId}
                      readOnly={readOnly}
                      onSelect={setSelectedId}
                      onChange={updateElement}
                      onStartEdit={(id) => setEditingId(id)}
                      onEndEdit={(id, value) => {
                        updateElement({ ...hydrate(currentSlide.elements.find((e) => e.id === id)), content: value });
                        setEditingId(null);
                      }}
                    />
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-gray-400 text-sm">
              {readOnly ? "No slides" : 'No slides yet — click "+ New slide" to start'}
            </div>
          )}
        </div>
      </div>

      {/* delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/50 flex justify-center items-center z-50">
          <div className="bg-white rounded-lg shadow-lg p-6 w-96 max-md:w-[90vw]">
            <h3 className="text-lg font-semibold mb-3">Delete this slide?</h3>
            <p className="text-gray-600 mb-5 text-sm">This can't be undone.</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="px-4 py-2 bg-gray-200 rounded-lg hover:bg-gray-300">
                Cancel
              </button>
              <button
                onClick={() => {
                  setSlides((prev) => prev.filter((s) => s.id !== confirmDelete));
                  setConfirmDelete(null);
                }}
                className="px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Lightweight scaled render of one slide (cards, pickers). No interactivity.
function SlidePreview({ slide, width = 256 }) {
  const scale = width / CANVAS_W;
  if (!slide)
    return (
      <div
        className="bg-gray-100 flex items-center justify-center text-gray-400 text-xs"
        style={{ width, height: (CANVAS_H / CANVAS_W) * width }}
      >
        No slides
      </div>
    );
  return (
    <div
      style={{
        width,
        height: (CANVAS_H / CANVAS_W) * width,
        overflow: "hidden",
        position: "relative",
        background: "white",
      }}
    >
      <div
        style={{
          width: CANVAS_W,
          height: CANVAS_H,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "relative",
          pointerEvents: "none",
        }}
      >
        {(slide.elements || []).map((raw) => {
          const el = hydrate(raw);
          return el.type === "image" ? (
            <img
              key={el.id}
              src={imgUrl(el.src)}
              alt=""
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
              }}
            >
              {el.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default SlideEditorWrapper;
export { hydrate, imgUrl, CANVAS_W, CANVAS_H, SlidePreview };
