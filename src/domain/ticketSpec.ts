import { z } from "zod";

export const ticketTypes = ["request", "incident"] as const;
export type TicketType = (typeof ticketTypes)[number];

const ticketTypeSchema = z.enum(ticketTypes);
const maxStringFieldLength = 500;
const maxListItems = 25;
const stringFieldSchema = z.string().trim().min(1).max(maxStringFieldLength);
const rawStringFieldSchema = z.string().trim().max(maxStringFieldLength);
const stringListSchema = z.array(stringFieldSchema).max(maxListItems);

const strictPartialTicketSpecSchema = z.object({
    title: stringFieldSchema.optional().nullable(),
    summary: stringFieldSchema.optional().nullable(),
    ticketType: ticketTypeSchema.optional().nullable(),
    affectedUsers: stringListSchema.optional(),
    affectedServices: stringListSchema.optional(),
    details: stringListSchema.optional(),
    impact: stringFieldSchema.optional().nullable(),
    environment: stringFieldSchema.optional().nullable(),
    reproductionSteps: stringListSchema.optional(),
    notes: stringListSchema.optional()
}).strict();

const rawPartialTicketSpecSchema = z.object({
    title: rawStringFieldSchema.optional().nullable(),
    summary: rawStringFieldSchema.optional().nullable(),
    ticketType: rawStringFieldSchema.optional().nullable(),
    affectedUsers: stringListSchema.optional(),
    affectedServices: stringListSchema.optional(),
    details: stringListSchema.optional(),
    impact: rawStringFieldSchema.optional().nullable(),
    environment: rawStringFieldSchema.optional().nullable(),
    reproductionSteps: stringListSchema.optional(),
    notes: stringListSchema.optional()
}).strict();

export const ticketSpecSchema = z.object({
    title: stringFieldSchema.optional().nullable(),
    summary: stringFieldSchema.optional().nullable(),
    ticketType: ticketTypeSchema.optional().nullable(),
    affectedUsers: stringListSchema.default([]),
    affectedServices: stringListSchema.default([]),
    details: stringListSchema.default([]),
    impact: stringFieldSchema.optional().nullable(),
    environment: stringFieldSchema.optional().nullable(),
    reproductionSteps: stringListSchema.default([]),
    notes: stringListSchema.default([])
}).strict();

export const partialTicketSpecSchema = rawPartialTicketSpecSchema.transform(normalizePartialTicketSpec);

export type TicketSpec = z.infer<typeof ticketSpecSchema>;
export type PartialTicketSpec = z.infer<typeof partialTicketSpecSchema>;
export type TicketSpecField = keyof TicketSpec;

export function createEmptyTicketSpec(): TicketSpec {
    return ticketSpecSchema.parse({});
}

export function normalizeTicketEnvironment(value: unknown): string | undefined {
    if (typeof value !== "string") {
        return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }

    if (/\bprod(?:uction)?\b/.test(normalized)) {
        return "production";
    }

    if (/\b(stag(?:ing)?|uat|qa|test)\b/.test(normalized)) {
        return "staging";
    }

    if (/\b(ios|iphone|ipad)\b/.test(normalized)) {
        return "iOS";
    }

    if (/\bandroid\b/.test(normalized)) {
        return "Android";
    }

    if (/\b(mobile|phone|tablet|native app)\b/.test(normalized)) {
        return "mobile";
    }

    if (/\b(web|browser|website)\b/.test(normalized)) {
        return "web";
    }

    if (/\b(desktop|windows|macos|mac)\b/.test(normalized)) {
        return "desktop";
    }

    return undefined;
}

function normalizePartialTicketSpec(
    rawSpec: z.infer<typeof rawPartialTicketSpecSchema>
): z.infer<typeof strictPartialTicketSpecSchema> {
    const normalized: Record<string, unknown> = { ...rawSpec };
    const ticketType = normalizeRawTicketType(rawSpec.ticketType);
    const environment = normalizeTicketEnvironment(rawSpec.ticketType);

    removeEmptyStringFields(normalized);

    if (ticketType === undefined) {
        delete normalized.ticketType;
    } else {
        normalized.ticketType = ticketType;
    }

    if (environment && !normalized.environment) {
        normalized.environment = environment;
    }

    return strictPartialTicketSpecSchema.parse(normalized);
}

function normalizeRawTicketType(value: string | null | undefined): TicketType | null | undefined {
    if (value === null || value === undefined) {
        return value;
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
        return undefined;
    }

    const directTicketType = ticketTypes.find((candidate) => candidate === normalized);
    if (directTicketType) {
        return directTicketType;
    }

    if (/\b(request|service request|feature request|access request|new access|password reset|reset access)\b/.test(normalized)) {
        return "request";
    }

    if (/\b(incident|bug|defect|issue|error|broken|failing|failure|outage|down)\b/.test(normalized)) {
        return "incident";
    }

    if (normalizeTicketEnvironment(normalized)) {
        return undefined;
    }

    return undefined;
}

function removeEmptyStringFields(value: Record<string, unknown>): void {
    for (const [field, fieldValue] of Object.entries(value)) {
        if (fieldValue === "") {
            delete value[field];
        }
    }
}