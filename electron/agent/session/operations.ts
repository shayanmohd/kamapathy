import { pageOperation, type PageOperation } from "../../automation-dom";
import { outlineBuilder } from "../dom/outline";
import { selectorEngine } from "../dom/select";

// Kamapathy's isolated world in each frame. Isolated init scripts use the
// same name, so they share it.
export const WORLD_NAME = "kamapathy";
// The page script with the selector engine and the outline builder passed in
// beside it, so selectors travel as JSON and the code that reads the page
// travels as code.
export const PAGE_SOURCE = `function(operation,payload,namespace){return (${pageOperation})(operation,payload,namespace,(${selectorEngine}),(${outlineBuilder}))}`;

// Operations that change the page themselves. The others only read it, even
// when they scroll a target into view to measure it.
export const OPERATIONS: Record<PageOperation, { mutates: boolean }> = {
  snapshot: { mutates: false },
  elements: { mutates: false },
  validate: { mutates: false },
  target: { mutates: false },
  click: { mutates: true },
  fill: { mutates: true },
  upload: { mutates: true },
  focus: { mutates: true },
  check: { mutates: false },
  scroll: { mutates: true },
  drag: { mutates: false },
  input: { mutates: false },
  frame: { mutates: false },
  ready: { mutates: false },
  frameIndex: { mutates: false },
};

export function operationExpression(
  op: PageOperation,
  payload: object,
  namespace: string,
): string {
  return `(${PAGE_SOURCE})(${JSON.stringify(op)},${JSON.stringify(payload)},${JSON.stringify(namespace)})`;
}
