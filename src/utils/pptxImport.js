import JSZip from "jszip";
import { v4 as uuidv4 } from "uuid";
import { CANVAS_W, CANVAS_H } from "../components/Ideas/SlideEditor";

// Import a .pptx into the Ideas slide format.
// Text boxes and images come in with their positions/sizes; complex layouts
// (tables, charts, grouped shapes, themes) are approximated or skipped.

const MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

const parseXml = (str) => new DOMParser().parseFromString(str, "application/xml");

// qualified-name lookup that also works if the parser drops prefixes
const q = (node, name) => {
  let els = node.getElementsByTagName(name);
  if (els.length === 0 && name.includes(":"))
    els = node.getElementsByTagName(name.split(":")[1]);
  return Array.from(els);
};

const attr = (el, name) => (el ? el.getAttribute(name) : null);

function shapeFrame(sp, pxPerEmuX, pxPerEmuY) {
  const xfrm = q(sp, "a:xfrm")[0];
  if (!xfrm) return null;
  const off = q(xfrm, "a:off")[0];
  const ext = q(xfrm, "a:ext")[0];
  if (!off || !ext) return null;
  return {
    left: Math.round(Number(attr(off, "x")) * pxPerEmuX),
    top: Math.round(Number(attr(off, "y")) * pxPerEmuY),
    width: Math.max(10, Math.round(Number(attr(ext, "cx")) * pxPerEmuX)),
    height: Math.max(10, Math.round(Number(attr(ext, "cy")) * pxPerEmuY)),
  };
}

function textFromShape(sp) {
  const paras = q(sp, "a:p");
  const lines = paras.map((p) =>
    q(p, "a:t")
      .map((t) => t.textContent)
      .join("")
  );
  const content = lines.join("\n").trim();
  if (!content) return null;

  // formatting from the first run that declares it
  const rPrs = q(sp, "a:rPr");
  let fontSize = 18;
  let bold = false;
  let color = "#1f2937";
  for (const r of rPrs) {
    const sz = attr(r, "sz");
    if (sz) {
      fontSize = Math.round((Number(sz) / 100) * (4 / 3)); // pt -> px
      bold = attr(r, "b") === "1";
      const clr = q(r, "a:srgbClr")[0];
      if (clr && attr(clr, "val")) color = `#${attr(clr, "val")}`;
      break;
    }
  }
  let align = "left";
  const pPr = q(sp, "a:pPr")[0];
  const algn = attr(pPr, "algn");
  if (algn === "ctr") align = "center";
  else if (algn === "r") align = "right";

  return { content, fontSize, bold, color, align };
}

async function uploadMedia(zip, mediaPath, supabase) {
  const f = zip.file(mediaPath);
  if (!f) return null;
  const ext = mediaPath.split(".").pop().toLowerCase();
  const buf = await f.async("arraybuffer");
  const blob = new Blob([buf], { type: MIME[ext] || "application/octet-stream" });
  const storagePath = `idea-images/pptx-${uuidv4()}.${ext}`;
  const { error } = await supabase.storage.from("echatbot").upload(storagePath, blob, {
    contentType: MIME[ext] || undefined,
  });
  if (error) {
    console.error("pptx media upload failed", mediaPath, error);
    return null;
  }
  const { data } = supabase.storage.from("echatbot").getPublicUrl(storagePath);
  return data?.publicUrl || null;
}

export async function importPptx(file, supabase, onProgress) {
  const zip = await JSZip.loadAsync(file);

  // slide size -> px-per-EMU for our 960x540 canvas
  const presXml = parseXml(await zip.file("ppt/presentation.xml").async("string"));
  const sldSz = q(presXml, "p:sldSz")[0];
  const cx = Number(attr(sldSz, "cx")) || 12192000;
  const cy = Number(attr(sldSz, "cy")) || 6858000;
  const pxPerEmuX = CANVAS_W / cx;
  const pxPerEmuY = CANVAS_H / cy;

  // true slide order: p:sldIdLst r:id -> presentation rels -> slide path
  const presRelsXml = parseXml(
    await zip.file("ppt/_rels/presentation.xml.rels").async("string")
  );
  const relMap = {};
  for (const rel of q(presRelsXml, "Relationship")) {
    relMap[attr(rel, "Id")] = attr(rel, "Target");
  }
  let slidePaths = q(presXml, "p:sldId")
    .map((s) => s.getAttribute("r:id") || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id"))
    .map((rid) => relMap[rid])
    .filter((t) => t && t.includes("slides/"))
    .map((t) => "ppt/" + t.replace(/^\.?\//, "").replace(/^ppt\//, ""));
  if (slidePaths.length === 0) {
    // fallback: numeric order
    slidePaths = Object.keys(zip.files)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  }

  const slides = [];
  const uploadedByMedia = {}; // reuse uploads when the same image repeats

  for (let i = 0; i < slidePaths.length; i++) {
    const path = slidePaths[i];
    if (onProgress) onProgress(`Slide ${i + 1} of ${slidePaths.length}...`);
    const xml = parseXml(await zip.file(path).async("string"));

    // slide rels for image targets
    const relsPath = path.replace("slides/", "slides/_rels/") + ".rels";
    const relsFile = zip.file(relsPath);
    const slideRels = {};
    if (relsFile) {
      const relsXml = parseXml(await relsFile.async("string"));
      for (const rel of q(relsXml, "Relationship")) {
        slideRels[attr(rel, "Id")] = attr(rel, "Target"); // e.g. ../media/image3.png
      }
    }

    const elements = [];

    for (const sp of q(xml, "p:sp")) {
      const frame = shapeFrame(sp, pxPerEmuX, pxPerEmuY);
      const text = textFromShape(sp);
      if (!frame || !text) continue;
      elements.push({
        id: uuidv4(),
        type: "text",
        left: frame.left,
        top: frame.top,
        width: frame.width,
        z: 2,
        italic: false,
        ...text,
      });
    }

    for (const pic of q(xml, "p:pic")) {
      const frame = shapeFrame(pic, pxPerEmuX, pxPerEmuY);
      if (!frame) continue;
      const blip = q(pic, "a:blip")[0];
      const rid =
        (blip && (blip.getAttribute("r:embed") ||
          blip.getAttributeNS(
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
            "embed"
          ))) || null;
      const target = rid ? slideRels[rid] : null;
      if (!target) continue;
      const mediaPath = "ppt/" + target.replace(/^(\.\.\/)+/, "").replace(/^\.?\//, "");
      if (!(mediaPath in uploadedByMedia)) {
        uploadedByMedia[mediaPath] = await uploadMedia(zip, mediaPath, supabase);
      }
      const url = uploadedByMedia[mediaPath];
      if (!url) continue;
      elements.push({
        id: uuidv4(),
        type: "image",
        src: url,
        content: mediaPath.split("/").pop(),
        left: frame.left,
        top: frame.top,
        width: frame.width,
        height: frame.height,
        z: 1,
      });
    }

    slides.push({
      id: uuidv4(),
      elements,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  return slides;
}
