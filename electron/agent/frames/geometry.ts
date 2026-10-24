// Section 9's frame math, in the main process: a point, a rectangle and the
// part of a frame the top viewport shows, mapped outward through the owners
// around it, and a top level area mapped back into a frame. This mirrors
// automation-dom's frameOrigin and placedRect, so the two agree; the page
// measures, and nothing here reads layout.

export interface Area {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export interface Point {
  x: number;
  y: number;
}
/**
 * An owner's content box in the world around it, with the scale a transform
 * or zoom applies, and the size of the content it shows in the document
 * inside it. This is what the page's frameOrigin already computes.
 */
export interface OwnerBox {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
}

/** Where a chain of owners, outermost first, places its innermost document. */
function chainOf(owners: readonly OwnerBox[]) {
  let x = 0;
  let y = 0;
  let scaleX = 1;
  let scaleY = 1;
  for (const owner of owners) {
    x += owner.x * scaleX;
    y += owner.y * scaleY;
    scaleX *= owner.scaleX;
    scaleY *= owner.scaleY;
  }
  return { x, y, scaleX, scaleY };
}

/** The scale the owners apply together, outermost first. */
export function scaleOf(owners: readonly OwnerBox[]): {
  scaleX: number;
  scaleY: number;
} {
  const { scaleX, scaleY } = chainOf(owners);
  return { scaleX, scaleY };
}

/** A point of the innermost document, in the world around the owners. */
export function mapPoint(point: Point, owners: readonly OwnerBox[]): Point {
  const { x, y, scaleX, scaleY } = chainOf(owners);
  return { x: x + point.x * scaleX, y: y + point.y * scaleY };
}

/** A rectangle of the innermost document, in the world around the owners. */
export function mapRect(rect: Area, owners: readonly OwnerBox[]): Area {
  const { x, y, scaleX, scaleY } = chainOf(owners);
  return {
    left: x + rect.left * scaleX,
    top: y + rect.top * scaleY,
    right: x + rect.right * scaleX,
    bottom: y + rect.bottom * scaleY,
  };
}

/**
 * The part of the viewport the innermost document can show: every owner's
 * content box, intersected at each boundary. An owner scrolled out of view
 * leaves an empty area.
 */
export function visibleArea(viewport: Area, owners: readonly OwnerBox[]): Area {
  const area = { ...viewport };
  let x = 0;
  let y = 0;
  let scaleX = 1;
  let scaleY = 1;
  for (const owner of owners) {
    x += owner.x * scaleX;
    y += owner.y * scaleY;
    scaleX *= owner.scaleX;
    scaleY *= owner.scaleY;
    area.left = Math.max(area.left, x);
    area.top = Math.max(area.top, y);
    area.right = Math.min(area.right, x + owner.width * scaleX);
    area.bottom = Math.min(area.bottom, y + owner.height * scaleY);
  }
  return area;
}

/**
 * An area of the world around the owners, in the innermost document's own
 * CSS pixels: the inverse of mapRect, which `scope: "viewport"` uses to read
 * only the part of a frame the person can see.
 */
export function innerArea(area: Area, owners: readonly OwnerBox[]): Area {
  const { x, y, scaleX, scaleY } = chainOf(owners);
  // An owner drawn at no scale shows nothing of its document.
  if (!scaleX || !scaleY) return { left: 0, top: 0, right: 0, bottom: 0 };
  return {
    left: (area.left - x) / scaleX,
    top: (area.top - y) / scaleY,
    right: (area.right - x) / scaleX,
    bottom: (area.bottom - y) / scaleY,
  };
}

/** Whether an area holds nothing: no width, no height, or inverted. */
export function emptyArea(area: Area): boolean {
  return area.right <= area.left || area.bottom <= area.top;
}
