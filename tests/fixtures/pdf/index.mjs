// PDF builders for the pdf tests and the end-to-end server. Each one
// returns the bytes of a small, valid PDF, so no binary files are kept.

const HEADER = "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n";

const latin1 = (text) => Buffer.from(text, "latin1");

// Objects are numbered from 1 in the order given.
function buildPdf(objects, trailer = "") {
  const parts = [latin1(HEADER)];
  const offsets = [];
  let offset = parts[0].length;
  const push = (part) => {
    const bytes = Buffer.isBuffer(part) ? part : latin1(part);
    parts.push(bytes);
    offset += bytes.length;
  };
  objects.forEach((body, index) => {
    offsets.push(offset);
    push(`${index + 1} 0 obj\n`);
    push(body);
    push("\nendobj\n");
  });
  const startXref = offset;
  const size = objects.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const entry of offsets)
    xref += `${String(entry).padStart(10, "0")} 00000 n \n`;
  push(xref);
  push(
    `trailer\n<< /Size ${size} /Root 1 0 R${trailer} >>\nstartxref\n${startXref}\n%%EOF\n`,
  );
  return Buffer.concat(parts);
}

function streamObject(dictionary, data) {
  const bytes = Buffer.isBuffer(data) ? data : latin1(data);
  return Buffer.concat([
    latin1(`<< ${dictionary} /Length ${bytes.length} >>\nstream\n`),
    bytes,
    latin1("\nendstream"),
  ]);
}

const pageObject = (contents, resources) =>
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << ${resources} >> /Contents ${contents} 0 R >>`;

const textEscape = (line) => line.replace(/([\\()])/gu, "\\$1");

// One Td and one Tj per line, which pdf.js reports as separate items with
// an end of line between them.
function textContent(lines) {
  let content = "BT\n/F1 12 Tf\n72 720 Td\n";
  lines.forEach((line, index) => {
    if (index > 0) content += "0 -18 Td\n";
    content += `(${textEscape(line)}) Tj\n`;
  });
  return `${content}ET\n`;
}

export function textPdf(pages, options = {}) {
  const font = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  const first = 4;
  const kids = pages
    .map((_page, index) => `${first + index * 2 + 1} 0 R`)
    .join(" ");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    font,
  ];
  for (const [index, lines] of pages.entries()) {
    objects.push(streamObject("", textContent(lines)));
    objects.push(pageObject(first + index * 2, "/Font << /F1 3 0 R >>"));
  }
  if (options.title === undefined) return buildPdf(objects);
  objects.push(`<< /Title (${textEscape(options.title)}) >>`);
  return buildPdf(objects, ` /Info ${objects.length} 0 R`);
}

export function imagePdf() {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    streamObject(
      "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8",
      Buffer.from([0x80]),
    ),
    streamObject("", "q\n200 0 0 200 100 500 cm\n/Im1 Do\nQ\n"),
    pageObject(4, "/XObject << /Im1 3 0 R >>"),
  ]);
}

// Needs the CMap directory: the text is UCS-2 under a predefined encoding.
export function cjkPdf(text = "你好世界") {
  let hex = "";
  for (const code of text.split(""))
    hex += code.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase();
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [6 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor 7 0 R /DW 1000 >>",
    streamObject("", `BT\n/F1 24 Tf\n72 700 Td\n<${hex}> Tj\nET\n`),
    pageObject(5, "/Font << /F1 3 0 R >>"),
    "<< /Type /FontDescriptor /FontName /STSong-Light /Flags 4 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -254 /CapHeight 880 /StemV 93 >>",
  ]);
}

// A user password pdf.js cannot guess, so it asks for one before reading
// anything.
export function lockedPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    streamObject("", textContent(["Locked"])),
    pageObject(4, "/Font << /F1 3 0 R >>"),
    `<< /Filter /Standard /V 1 /R 2 /O <${"ab".repeat(32)}> /U <${"cd".repeat(32)}> /P -1 >>`,
  ];
  return buildPdf(
    objects,
    ` /Encrypt 6 0 R /ID [<${"11".repeat(16)}> <${"11".repeat(16)}>]`,
  );
}

export function truncatedPdf() {
  const bytes = textPdf([["First page"], ["Second page"]]);
  return bytes.subarray(0, Math.floor(bytes.length / 2));
}
