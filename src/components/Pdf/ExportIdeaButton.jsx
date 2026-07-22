import { useRef, useState, useEffect } from "react";
import html2pdf from "html2pdf.js";
import { FileDown, Presentation } from "lucide-react";
import PDFPortal from "./PdfPortal";
import SlideRenderer from "../Ideas/SlideExportRenderer";
import { exportIdeaPptx } from "../../utils/pptxExport";

// One-click PDF of a single idea/deck — landscape letter, one slide per page.
export default function ExportIdeaButton({ idea }) {
  const pdfRef = useRef();
  const [rendering, setRendering] = useState(false);
  const [pptxBusy, setPptxBusy] = useState(false);

  const handlePptx = async () => {
    setPptxBusy(true);
    try {
      await exportIdeaPptx(idea);
    } catch (e) {
      console.error("pptx export failed", e);
    } finally {
      setPptxBusy(false);
    }
  };

  useEffect(() => {
    if (!rendering) return;
    const timeout = setTimeout(async () => {
      await preloadImages(pdfRef.current);
      const opt = {
        margin: 0,
        filename: `${(idea.name || "deck").replace(/[\\/:*?"<>|]/g, "")}.pdf`,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "in", format: "letter", orientation: "landscape" },
      };
      const worker = html2pdf().set(opt).from(pdfRef.current);
      const pdfBlob = await worker.outputPdf("blob");
      const url = URL.createObjectURL(pdfBlob);
      window.open(url, "_blank");
      setRendering(false);
    }, 600);
    return () => clearTimeout(timeout);
  }, [rendering, idea]);

  return (
    <>
      <button
        type="button"
        onClick={() => setRendering(true)}
        disabled={rendering || !idea?.slides?.length}
        className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-md flex items-center gap-2 disabled:opacity-50"
        title="Export this deck as a PDF"
      >
        <FileDown className="w-4 h-4" />
        {rendering ? "Exporting..." : "Export PDF"}
      </button>
      <button
        type="button"
        onClick={handlePptx}
        disabled={pptxBusy || !idea?.slides?.length}
        className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-md flex items-center gap-2 disabled:opacity-50 ml-2"
        title="Export as an editable PowerPoint file"
      >
        <Presentation className="w-4 h-4" />
        {pptxBusy ? "Exporting..." : "Export PPTX"}
      </button>
      {rendering && (
        <PDFPortal>
          <div ref={pdfRef} className="bg-white text-black">
            {(idea.slides || []).map((slide) => (
              <SlideRenderer key={slide.id} slide={slide} />
            ))}
          </div>
        </PDFPortal>
      )}
    </>
  );
}

function preloadImages(container) {
  const images = container.querySelectorAll("img");
  const promises = [];
  images.forEach((img) => {
    if (img.complete) return;
    promises.push(
      new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
      })
    );
  });
  return Promise.all(promises);
}
