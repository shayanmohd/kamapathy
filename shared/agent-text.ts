// Text an agent wrote, made safe to show as one line: line and paragraph
// breaks become spaces, other control and bidirectional formatting
// characters go, and whitespace collapses.
const BREAKS = /[\n\r\t\u0085\u2028\u2029]/g;
const CONTROLS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export function cleanAgentText(value: string): string {
  return value
    .replace(BREAKS, " ")
    .replace(CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
}

// How long each kind of agent text may be, counted in UTF-16 units before
// cleaning, as for every other field.
export const AGENT_TEXT_LIMITS = {
  label: 60,
  status: 120,
  message: 300,
  name: 48,
} as const;
export type AgentTextField = keyof typeof AGENT_TEXT_LIMITS;
