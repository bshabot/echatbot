import { useRef, useState, useEffect } from "react";
import html2pdf from "html2pdf.js";
import PDFPortal from "./PdfPortal";
import SlideRenderer from "../Ideas/SlideExportRenderer";

export default function IdeasExportButton({
  fetchIdeas,
  setSelectedIdeas,
  setIsSelectionMode,
  children,
}) {
  const pdfRef = useRef();
  const [rendering, setRendering] = useState(false);
  const [exportItems, setExportItems] = useState([]);

  const handleExport = async () => {
    const ideasData = await fetchIdeas();
    if (!ideasData || ideasData.length === 0) return;

    setExportItems(ideasData);
    setRendering(true);
  };

  useEffect(() => {
    if (!rendering || exportItems.length === 0) return;

    const timeout = setTimeout(async () => {
      await preloadImages(pdfRef.current);
      const opt = {
        margin: 0,
        filename: "designs.pdf",
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true },
        jsPDF: { unit: "in", format: "letter", orientation: "landscape" },
      };

      const worker = html2pdf().set(opt).from(pdfRef.current);
      const pdfBlob = await worker.outputPdf("blob");
      const url = URL.createObjectURL(pdfBlob);
      window.open(url, "_blank");

      setRendering(false);
      setExportItems([]);
      setSelectedIdeas(new Set());
      setIsSelectionMode(false);
    }, 600); // let DOM render first

    return () => clearTimeout(timeout);
  }, [rendering, exportItems]);

  return (
    <>
      {children(handleExport)}

      {rendering && (
        <PDFPortal>
          <div ref={pdfRef} className=" bg-white text-black w-[11in]">
            {exportItems.map((idea) => (
              <div key={idea.id}>
                <h1 className="text-xl font-bold text-black">{idea.name}</h1>
                {idea.slides.map((slide) => (
                  <SlideRenderer key={slide.id} slide={slide} />
                ))}
              </div>
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
