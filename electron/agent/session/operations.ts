import { pageOperation, type PageOperation } from "../../automation-dom";
import { FILES_SOURCE, fileOperation } from "../dom/files";
import { actionOperations, fillClassifier } from "../dom/actions";
import { fetchOperation } from "../dom/fetch";
import { bindFrameOwner } from "../dom/frame-owner";
import { outlineBuilder } from "../dom/outline";
import { pageState, type PageStateOperation } from "../dom/page-state";
import { selectorEngine } from "../dom/select";

// Kamapathy's isolated world in each frame. Isolated init scripts use the
// same name, so they share it.
export const WORLD_NAME = "kamapathy";
// The page script with the selector engine, the outline builder and the file
// and action operations passed in beside it, so selectors travel as JSON and
// the code that reads the page travels as code.
export const PAGE_SOURCE = `function(operation,payload,namespace){return (${pageOperation})(operation,payload,namespace,(${selectorEngine}),(${outlineBuilder}),(${fileOperation}),(${actionOperations}),(${fillClassifier}))}`;
export const PAGE_STATE_SOURCE = pageState.toString();
// The in-page fetch travels with the page script only for the operation that
// runs it, which resolves no selector and reads no outline.
export const FETCH_SOURCE = `function(operation,payload,namespace){return (${pageOperation})(operation,payload,namespace,undefined,undefined,undefined,undefined,undefined,(${fetchOperation}))}`;
// Section 9's owner binding, which the main process calls on an owner object
// it resolved into this world rather than on a payload.
export const FRAME_OWNER_SOURCE = `(${bindFrameOwner})`;

// Operations that change the page themselves. The others only read it, even
// when they scroll a target into view to measure it. `source` names the
// serialized function an operation runs when it is not pageOperation.
export const OPERATIONS: Record<
  PageOperation | PageStateOperation,
  { mutates: boolean; source?: "pageState" | "files" | "fetch" }
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
  actionPoint: { mutates: false },
  stableBox: { mutates: false },
  scrollRequest: { mutates: false },
  viewport: { mutates: false },
  focusedKind: { mutates: false },
  fillPrepare: { mutates: true },
  fillRead: { mutates: false },
  setDirectValue: { mutates: true },
  selectChoose: { mutates: true },
  focusTarget: { mutates: true },
  pasteDispatch: { mutates: true },
  frameBox: { mutates: false },
  activeFrame: { mutates: false },
  fetch: { mutates: true, source: "fetch" },
  info: { mutates: false, source: "pageState" },
  loadProbe: { mutates: false, source: "pageState" },
  // The retarget needs the page script's resolver and refs; the apply runs on
  // its own, so the file chooser can call it on a node with no ref.
  retargetFile: { mutates: false },
  applyFiles: { mutates: true, source: "files" },
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
  const source =
    OPERATIONS[op].source === "files" ? FILES_SOURCE : PAGE_SOURCE;
  return `(${source})(${JSON.stringify(op)},${JSON.stringify(payload)},${JSON.stringify(namespace)})`;
}
