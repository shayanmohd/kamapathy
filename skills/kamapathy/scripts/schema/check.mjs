// Checks calls and request bodies against the schema before anything is
// sent, with the wording the server has always used for its fields.
import { ACTIONS } from "./routes.mjs";

const problem = (code, message, fields) => ({ code, message, fields });
const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const either = (values) =>
  values.length < 3
    ? values.join(" or ")
    : `${values.slice(0, -1).join(", ")}, or ${values.at(-1)}`;
const all = (values) =>
  values.length < 3
    ? values.join(" and ")
    : `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
const callName = (entry) => entry.signature.split("(")[0];

function bounds(field) {
  if (field.kind === "ms") return [field.min ?? 0, field.max ?? 60000];
  return [field.min, field.max];
}
function range(what, [min, max]) {
  if (min === undefined && max === undefined) return what;
  if (max === undefined) return `${what} of at least ${min}`;
  if (min === undefined) return `${what} of at most ${max}`;
  return `${what} from ${min} to ${max}`;
}

// What a field accepts, as the end of "<field> must be ...".
function expectation(field) {
  switch (field.kind) {
    case "string": {
      const what = (field.min ?? 1) > 0 ? "a nonempty string" : "a string";
      return field.max === undefined
        ? what
        : `${what} of at most ${field.max} characters`;
    }
    case "target":
      return `a nonempty string of at most ${field.max ?? 2048} characters`;
    case "url":
      return `a nonempty string of at most ${field.max ?? 8192} characters`;
    case "integer":
    case "ms":
      return range("an integer", bounds(field));
    case "number":
      return range("a number", bounds(field));
    case "boolean":
      return "true or false";
    case "enum":
      return either(field.values);
    case "array":
      return "an array";
    case "json":
      return "JSON";
    default:
      return "an object";
  }
}

function fits(value, field) {
  const [min, max] = bounds(field);
  const inRange = (number) =>
    (min === undefined || number >= min) &&
    (max === undefined || number <= max);
  switch (field.kind) {
    case "string":
      return (
        typeof value === "string" &&
        ((field.min ?? 1) === 0 || value.trim() !== "") &&
        (field.max === undefined || value.length <= field.max)
      );
    case "target":
      return (
        typeof value === "string" &&
        value.trim() !== "" &&
        value.length <= (field.max ?? 2048)
      );
    case "url":
      return (
        typeof value === "string" &&
        value.trim() !== "" &&
        value.length <= (field.max ?? 8192)
      );
    case "integer":
    case "ms":
      return Number.isInteger(value) && inRange(value);
    case "number":
      return (
        typeof value === "number" && Number.isFinite(value) && inRange(value)
      );
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return field.values.includes(value);
    case "array":
      return Array.isArray(value);
    case "json":
      return true;
    default:
      return plain(value);
  }
}

// A field of the wrong kind, as invalid_field.
const invalid = (at, field, context) =>
  problem("invalid_field", `${at} must be ${expectation(field)}.`, {
    field: at,
    expected: expectation(field),
    ...context.extra,
  });
// An undeclared key, as unknown_field. At the top of a batch step the
// allowed list starts with type.
const unknown = (field, allowed, depth, context) => {
  const names = depth === 0 ? [...(context.top ?? []), ...allowed] : allowed;
  const suggestion = suggest(field.split(".").at(-1), names);
  return problem(
    "unknown_field",
    `${context.start} has no field "${field}". Allowed: ${names.length ? names.join(", ") : "none"}.${
      suggestion ? ` Did you mean "${suggestion}"?` : ""
    }`,
    {
      field,
      allowed: names,
      ...context.extra,
      ...context.step,
      ...(suggestion ? { suggestion } : {}),
    },
  );
};

// The first problem in a body's fields: an undeclared key first, then each
// declared field in order. An undefined value counts as absent. Items of an
// array of objects are checked under their own names, with their index.
function checkFields(fields, body, path, context, depth = 0) {
  for (const [key, value] of Object.entries(body))
    if (value !== undefined && !Object.hasOwn(fields, key))
      return unknown(`${path}${key}`, Object.keys(fields), depth, context);
  for (const [key, field] of Object.entries(fields)) {
    const value = body[key];
    const at = `${path}${key}`;
    if (value === undefined) {
      if (field.required) return invalid(at, field, context);
      continue;
    }
    if (!fits(value, field)) return invalid(at, field, context);
    if (field.kind === "object" && field.fields) {
      const found = checkFields(
        field.fields,
        value,
        `${at}.`,
        context,
        depth + 1,
      );
      if (found) return found;
    }
    if (field.kind === "map" && field.of)
      for (const item of Object.values(value))
        if (!fits(item, field.of)) return invalid(at, field.of, context);
    if (field.kind === "array" && field.of === "action") {
      const found = checkSteps(value);
      if (found) return found;
    } else if (field.kind === "array" && field.of)
      for (const [index, item] of value.entries()) {
        const items = { ...context, extra: { ...context.extra, index } };
        if (!fits(item, field.of)) return invalid(at, field.of, items);
        if (field.of.kind === "object" && field.of.fields) {
          const found = checkFields(
            field.of.fields,
            item,
            "",
            items,
            depth + 1,
          );
          if (found) return found;
        }
      }
  }
  return null;
}

// Batch steps: each an object whose type is a declared action, with only
// that action's fields.
function checkSteps(steps) {
  const types = ACTIONS.map((item) => item.type);
  for (const [index, step] of steps.entries()) {
    if (!plain(step) || typeof step.type !== "string" || !step.type)
      return problem(
        "invalid_action",
        "Each action must be an object with a type.",
        { allowed: types, index },
      );
    const spec = ACTIONS.find((item) => item.type === step.type);
    if (!spec)
      return problem("invalid_action", `Batch actions support ${all(types)}.`, {
        allowed: types,
        index,
      });
    const { type, ...fields } = step;
    const found = checkFields(spec.fields, fields, "", {
      start: `Batch step ${index + 1} (${type})`,
      extra: { index },
      step: { action: type },
      top: ["type"],
    });
    if (found) return found;
  }
  return null;
}

// A body against its route: unknown_field, invalid_field or invalid_action,
// or null when it fits. Routes without a body declaration read none.
export function checkBody(route, body) {
  if (!route.body) return null;
  const given = body ?? {};
  if (!plain(given))
    return problem(
      "invalid_body",
      "The request body must be a JSON object.",
      {},
    );
  return checkFields(route.body, given, "", {
    start: `${route.method} ${route.path}`,
    extra: {},
  });
}

const kindOf = (value) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string")
    return value.trim() ? "a string" : "an empty string";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
};
const optionsShape = (options = {}) => {
  const keys = Object.entries(options).map(
    ([key, field]) => `${key}${field.required ? "" : "?"}`,
  );
  return keys.length ? `{ ${keys.join(", ")} }` : "{}";
};
const shapeOf = (entry, args) =>
  `${callName(entry)}(${args
    .map((arg) =>
      arg.kind === "options"
        ? optionsShape(entry.options)
        : `${arg.name}${arg.optional ? "?" : ""}`,
    )
    .join(", ")})`;

function argumentFits(value, arg) {
  switch (arg.kind) {
    case "string":
      return typeof value === "string";
    // Agent text within its limit; nullable text also takes null.
    case "text":
      return arg.nullable && value === null
        ? true
        : typeof value === "string" &&
            ((arg.min ?? 1) === 0 || value.trim() !== "") &&
            (arg.max === undefined || value.length <= arg.max);
    case "url":
    case "target":
      return typeof value === "string" && value.trim() !== "";
    case "label":
      return typeof value === "string" && /^p[1-9][0-9]*$/.test(value);
    case "keep":
      return (
        plain(value) && (value.keep === "all" || Array.isArray(value.keep))
      );
    case "enum":
      return arg.values.includes(value);
    case "integer":
      return Number.isInteger(value);
    // Milliseconds in the range the argument declares, as a field's are.
    case "ms":
      return fits(value, arg);
    // A URL glob the main process matches, or a RegExp or predicate the
    // client tests itself.
    case "matcher":
      return (
        value instanceof RegExp ||
        typeof value === "function" ||
        (typeof value === "string" && value.trim() !== "")
      );
    // A function to call in the page, or the source of one.
    case "pageFunction":
      return (
        typeof value === "function" ||
        (typeof value === "string" && value.trim() !== "")
      );
    case "array":
      return (
        Array.isArray(value) && value.every((item) => typeof item === "string")
      );
    // A Page, a tab id or a label.
    case "page":
      return typeof value === "string"
        ? value.trim() !== ""
        : value !== null &&
            typeof value === "object" &&
            (typeof value.id === "string" || typeof value.label === "string");
    default:
      return true;
  }
}

// app_outdated for a call, option or command the app's level is below.
export function outdated(name, required, app, option) {
  return problem(
    "app_outdated",
    `${option ? `${name} option "${option}"` : name} needs Kamapathy API level ${required}, and ${
      app.version ? `Kamapathy ${app.version}` : "Kamapathy"
    } has level ${app.apiLevel}. Ask the person to update Kamapathy, then read the skill again.`,
    {
      entry: name,
      ...(option ? { option } : {}),
      required,
      available: app.apiLevel,
      ...(app.version ? { appVersion: app.version } : {}),
    },
  );
}

function checkOptions(entry, value, expected, app) {
  const name = callName(entry);
  if (!plain(value))
    return problem(
      "invalid_option",
      `${name} got ${kindOf(value)} instead of an options object. Expected ${expected}.`,
      {
        entry: name,
        expected,
      },
    );
  const options = entry.options ?? {};
  for (const [key, given] of Object.entries(value)) {
    if (given === undefined || Object.hasOwn(options, key)) continue;
    const suggestion = suggest(key, Object.keys(options));
    return problem(
      "invalid_option",
      `${name} got unknown option "${key}". Expected ${expected}.${suggestion ? ` Did you mean "${suggestion}"?` : ""}`,
      {
        entry: name,
        option: key,
        expected,
        ...(suggestion ? { suggestion } : {}),
      },
    );
  }
  for (const [key, field] of Object.entries(options)) {
    const given = value[key];
    if (given === undefined && !field.required) continue;
    if (given !== undefined && app && (field.since ?? 1) > app.apiLevel)
      return outdated(name, field.since, app, key);
    if (given === undefined || !fits(given, field))
      return problem(
        "invalid_option",
        `${name} got an invalid option: ${key} must be ${expectation(field)}. Expected ${expected}.`,
        { entry: name, option: key, expected },
      );
  }
  return null;
}

function checkArguments(entry, shape, args, expected, app) {
  const name = callName(entry);
  const fail = (message, extra = {}) =>
    problem("invalid_argument", message, { entry: name, expected, ...extra });
  if (args.length > shape.length)
    return fail(`${name} got ${args.length} arguments. Expected ${expected}.`);
  for (const [index, arg] of shape.entries()) {
    const value = args[index];
    if (value === undefined) {
      if (arg.optional) continue;
      return fail(`${name} got no ${arg.name}. Expected ${expected}.`);
    }
    if (arg.kind === "options") {
      const found = checkOptions(entry, value, expected, app);
      if (found) return found;
    } else if (arg.kind === "actions") {
      if (!Array.isArray(value))
        return fail(
          `${name} got ${kindOf(value)} for ${arg.name}. Expected ${expected}.`,
        );
      const found = checkSteps(value);
      if (found)
        return fail(
          `${name} got an invalid batch: ${found.message} Expected ${expected}.`,
          {
            index: found.fields.index,
            ...(found.fields.field ? { field: found.fields.field } : {}),
          },
        );
    } else if (!argumentFits(value, arg)) {
      const shown =
        arg.kind === "enum" && typeof value === "string"
          ? JSON.stringify(value)
          : kindOf(value);
      return fail(
        `${name} got ${shown} for ${arg.name}. Expected ${expected}.`,
      );
    }
    // An argument the app predates, reported only once the value fits it, so
    // another overload can still take that value.
    if (app && (arg.since ?? 1) > app.apiLevel)
      return outdated(name, arg.since, app);
  }
  return null;
}

// A client call against its entry: invalid_argument, invalid_option, or,
// when the app's level is known, app_outdated; null when it fits. Trailing
// undefined arguments count as omitted.
export function checkCall(entry, args, app) {
  const name = callName(entry);
  if (app && entry.since > app.apiLevel)
    return outdated(name, entry.since, app);
  const shapes = entry.overloads ?? [entry.args ?? []];
  const expected =
    entry.expected ?? shapes.map((shape) => shapeOf(entry, shape)).join(" or ");
  let count = args.length;
  while (count > 0 && args[count - 1] === undefined) count--;
  let first = null;
  for (const shape of shapes) {
    const found = checkArguments(
      entry,
      shape,
      args.slice(0, count),
      expected,
      app,
    );
    if (!found) return null;
    first ??= found;
  }
  return first;
}

export function editDistance(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length];
}

// A declared name within two edits of name, or one that differs from it
// only by an Ms suffix.
export function suggest(name, candidates) {
  let best;
  let distance = 3;
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const edits =
      candidate === `${name}Ms` || name === `${candidate}Ms`
        ? 0
        : editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (edits < distance) {
      best = candidate;
      distance = edits;
    }
  }
  return best;
}
