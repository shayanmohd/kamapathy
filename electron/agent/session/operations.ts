import { pageOperation, type PageOperation } from "../../automation-dom";
import { fetchOperation } from "../dom/fetch";
import { outlineBuilder } from "../dom/outline";
import { pageState, type PageStateOperation } from "../dom/page-state";
import { selectorEngine } from "../dom/select";

// Kamapathy's isolated world in each frame. Isolated init scripts use the
// same name, so they share it.
export const WORLD_NAME = "kamapathy";
// The page script with the selector engine and the outline builder passed in
// beside it, so selectors travel as JSON and the code that reads the page
// travels as code.
export const PAGE_SOURCE = `function(operation,payload,namespace){return (${pageOperation})(operation,payload,namespace,(${selectorEngine}),(${outlineBuilder}))}`;
export const PAGE_STATE_SOURCE = pageState.toString();
// The in-page fetch travels with the page script only for the operation that
// runs it, which resolves no selector and reads no outline.
export const FETCH_SOURCE = `function(operation,payload,namespace){return (${pageOperation})(operation,payload,namespace,undefined,undefined,(${fetchOperation}))}`;

// Operations that change the page themselves. The others only read it, even
// when they scroll a target into view to measure it. `source` names the
// serialized function an operation runs when it is not pageOperation.
export const OPERATIONS: Record<
  PageOperation | PageStateOperation,
  { mutates: boolean; source?: "pageState" | "fetch" }
> = {
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
  fetch: { mutates: true, source: "fetch" },
  info: { mutates: false, source: "pageState" },
  loadProbe: { mutates: false, source: "pageState" },
};

export function operationExpression(
  op: PageOperation | PageStateOperation,
  payload: object,
  namespace: string,
): string {
  if (OPERATIONS[op].source === "pageState")
    return `(${PAGE_STATE_SOURCE})(${JSON.stringify(op)})`;
  if (OPERATIONS[op].source === "fetch")
    return `(${FETCH_SOURCE})(${JSON.stringify(op)},${JSON.stringify(payload)},${JSON.stringify(namespace)})`;
  return `(${PAGE_SOURCE})(${JSON.stringify(op)},${JSON.stringify(payload)},${JSON.stringify(namespace)})`;
}
