import type { TicketSpec, TicketSpecField, TicketType } from "./ticketSpec";

const requiredFields: Record<TicketType, TicketSpecField[]> = {
  request: ["summary", "affectedUsers", "affectedServices", "details"],
  incident: ["summary", "affectedUsers", "affectedServices", "details", "impact"]
};

const vagueSummaries = new Set(["ticket", "request", "incident", "bug", "issue", "problem", "support"]);

export function getRequiredFields(ticketType: TicketType): TicketSpecField[] {
  return requiredFields[ticketType];
}

export function getRequiredFieldsForSpec(spec: TicketSpec): TicketSpecField[] {
  const fields = new Set<TicketSpecField>(["ticketType", "summary"]);

  if (spec.ticketType) {
    for (const field of getRequiredFields(spec.ticketType)) {
      fields.add(field);
    }
  }

  return [...fields];
}

export function getMissingFields(spec: TicketSpec): TicketSpecField[] {
  const missing = new Set<TicketSpecField>();

  if (!spec.ticketType) {
    missing.add("ticketType");
  }

  if (isSummaryMissing(spec)) {
    missing.add("summary");
  }

  const fieldsToCheck = spec.ticketType ? getRequiredFields(spec.ticketType) : [];

  for (const field of fieldsToCheck) {
    if (isFieldMissing(spec, field)) {
      missing.add(field);
    }
  }

  return [...missing];
}

export function isReadyToBuild(spec: TicketSpec): boolean {
  return getMissingFields(spec).length === 0;
}

function isSummaryMissing(spec: TicketSpec): boolean {
  const summary = spec.summary?.trim().toLowerCase();
  if (!summary) {
    return true;
  }

  if (vagueSummaries.has(summary)) {
    return true;
  }

  return spec.ticketType ? summary === spec.ticketType : false;
}

function isFieldMissing(spec: TicketSpec, field: TicketSpecField): boolean {
  const value = spec[field];

  if (field === "summary") {
    return isSummaryMissing(spec);
  }

  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return value === null || value === undefined || value === "";
}

