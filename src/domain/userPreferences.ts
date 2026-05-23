import { z } from "zod";
import { ticketTypes, type TicketSpec } from "./ticketSpec";

const stringFieldSchema = z.string().trim().min(1);

export const userPreferencesSchema = z.object({
  userId: stringFieldSchema,
  preferredTicketType: z.enum(ticketTypes).optional().nullable(),
  preferredEnvironment: stringFieldSchema.optional().nullable(),
  preferredAffectedServices: z.array(stringFieldSchema).default([]),
  updatedAt: z.string()
});

export type UserPreferences = z.infer<typeof userPreferencesSchema>;

export function createUserPreferences(userId: string, updatedAt = new Date().toISOString()): UserPreferences {
  return userPreferencesSchema.parse({
    userId,
    updatedAt
  });
}

export function mergeUserPreferencesFromTicketSpec(existing: UserPreferences, ticketSpec: TicketSpec): UserPreferences {
  const next: UserPreferences = {
    ...existing,
    preferredAffectedServices: [...existing.preferredAffectedServices]
  };

  if (ticketSpec.ticketType) {
    next.preferredTicketType = ticketSpec.ticketType;
  }

  if (ticketSpec.environment) {
    next.preferredEnvironment = ticketSpec.environment;
  }

  if (ticketSpec.affectedServices.length > 0) {
    next.preferredAffectedServices = mergePreferenceList(next.preferredAffectedServices, ticketSpec.affectedServices);
  }

  next.updatedAt = new Date().toISOString();
  return userPreferencesSchema.parse(next);
}

function mergePreferenceList(existing: string[], incoming: string[]): string[] {
  const valuesByKey = new Map<string, string>();

  for (const value of [...existing, ...incoming]) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();
    if (!valuesByKey.has(key)) {
      valuesByKey.set(key, trimmed);
    }
  }

  return [...valuesByKey.values()];
}
