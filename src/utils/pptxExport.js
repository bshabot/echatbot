import Pptxgen from "pptxgenjs";
import { hydrate, imgUrl } from "../components/Ideas/SlideEditor";

// Export an idea's slides as a real, editable PowerPoint file.
// Canvas units are 960x540 px; PowerPoint wide layout is 13.333x7.5in.
// 960 / 72 = 13.333 exactly, so inches = px / 72 maps 1:1.
const PX_PER_IN = 72;

export async function exportIdeaPptx(idea) {
  const pptx = new Pptxgen();
  pptx.defineLayout({ name: "ECHABOT_WIDE", width: 13.333, height: 7.5 });
  pptx.layout = "ECHABOT_WIDE";

  for (const slideData of idea.slides || []) {
    const slide = pptx.addSlide();
    const els = (slideData.elements || []).map(hydrate).sort((a, b) => (a.z || 1) - (b.z || 1));
    for (const el of els) {
      const x = el.left / PX_PER_IN;
      const y = el.top / PX_PER_IN;
      if (el.type === "image") {
        slide.addImage({
          path: imgUrl(el.src),
          x,
          y,
          w: el.width / PX_PER_IN,
          h: el.height / PX_PER_IN,
        });
      } else {
        slide.addText(el.content || "", {
          x,
          y,
          w: (el.width || 240) / PX_PER_IN,
          h: Math.max((el.height || 40) / PX_PER_IN, 0.4),
          fontSize: Math.round((el.fontSize || 20) * 0.75), // px -> pt
          bold: !!el.bold,
          italic: !!el.italic,
          color: (el.color || "#1f2937").replace("#", ""),
          align: el.align || "left",
          valign: "top",
          fontFace: "Calibri",
        });
      }
    }
  }

  const fileName = `${(idea.name || "deck").replace(/[\\/:*?"<>|]/g, "")}.pptx`;
  await pptx.writeFile({ fileName });
}
