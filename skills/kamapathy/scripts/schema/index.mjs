// Kamapathy's API in one place: script globals and client members, CLI
// commands, HTTP routes, batch actions and error codes. Data and pure
// functions only, so the skill and the app both import it.
import { COMMANDS } from "./cli.mjs";
import { CLIENT, GLOBALS } from "./globals.mjs";
import { PAGE_ENTRIES } from "./page.mjs";
import { SPACE } from "./space.mjs";

export {
  checkBody,
  checkCall,
  editDistance,
  outdated,
  pointFrom,
  suggest,
} from "./check.mjs";
export { COMMANDS, ENVIRONMENT, GLOBAL_FLAGS } from "./cli.mjs";
export { ERRORS, isTransient } from "./errors.mjs";
export {
  ACTIONS,
  COMPUTE,
  ROUTES,
  matchRoute,
  requestBudget,
  routeKey,
} from "./routes.mjs";
export { SELECTOR_FORMS } from "./selectors.mjs";

export const CLIENT_VERSION = "0.2.0";
export const API_LEVEL = 4;

export const ENTRIES = [...GLOBALS, ...CLIENT, ...SPACE, ...PAGE_ENTRIES];

// An entry by its schema name (Page.wait) or the name it is called by
// (page.wait).
export const findEntry = (name) =>
  ENTRIES.find((entry) => entry.name === name) ??
  ENTRIES.find((entry) => entry.signature.split("(")[0] === name);
export const findCommand = (name) =>
  COMMANDS.find((command) => command.name === name);
