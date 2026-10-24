export function textPdf(
  pages: string[][],
  options?: { title?: string },
): Buffer;
export function imagePdf(): Buffer;
export function cjkPdf(text?: string): Buffer;
export function lockedPdf(): Buffer;
export function truncatedPdf(): Buffer;
