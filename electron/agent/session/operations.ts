import { pageOperation, type PageOperation } from "../../automation-dom";
import { actionOperations, fillClassifier } from "../dom/actions";
import { outlineBuilder } from "../dom/outline";
import { pageState, type PageStateOperation } from "../dom/page-state";
import { selectorEngine } from "../dom/select";

// Kamapathy's isolated world in each frame. Isolated init scripts use the
// same name, so they share it.
export const WORLD_NAME = "kamapathy";
// The page script with the selector engine, the outline builder and the
// action operations passed in beside it, so selectors travel as JSON and the
// code that reads the page travels as code.
export const PAGE_SOURCE = `function(operation,payload,namespace){return (${pageOperation})(operation,payload,namespace,(${selectorEngine}),(${outlineBuilder}),(${actionOperations}),(${fillClassifier}))}`;
export const PAGE_STATE_SOURCE = pageState.toString();

// Operations that change the page themselves. The others only read it, even
// when they scroll a target into view to measure it. `source` names the
// serialized function an operation runs when it is not pageOperation.
export const OPERATIONS: Record<
  PageOperation | PageStateOperation,
  { mutates: boolean; source?: "pageState" }
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
  return `(${PAGE_SOURCE})(${JSON.stringify(op)},${JSON.stringify(payload)},${JSON.stringify(namespace)})`;
}
