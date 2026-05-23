import { ticketSpecSchema, type TicketSpec, type PartialTicketSpec } from "./ticketSpec";

const listFields = [
  "affectedUsers",
  "affectedServices",
  "details",
  "reproductionSteps",
  "notes"
] as const;

const scalarFields = ["title", "summary", "ticketType", "impact", "environment"] as const;

export function mergeTicketSpec(existing: TicketSpec, extracted: PartialTicketSpec): TicketSpec {
  const next: TicketSpec = { ...existing };

  for (const field of scalarFields) {
    const value = extracted[field];
    if (value !== undefined && value !== null && value !== "") {
      next[field] = value as never;
    }
  }

  for (const field of listFields) {
    const value = extracted[field];
    if (value && value.length > 0) {
      next[field] = mergeLists(existing[field], value) as never;
    }
  }

  return ticketSpecSchema.parse(next);
}

function mergeLists(existing: string[], incoming: string[]): string[] {
  const byKey = new Map<string, string>();

  for (const value of [...existing, ...incoming]) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, trimmed);
    }
  }

  return [...byKey.values()];
}

