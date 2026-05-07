import { z } from "zod";

export const appTypes = ["dashboard", "workflow", "crud", "chatbot", "portal", "other"] as const;
export type AppType = (typeof appTypes)[number];

const appTypeSchema = z.enum(appTypes);
const stringFieldSchema = z.string().trim().min(1);
const stringListSchema = z.array(stringFieldSchema);

const strictPartialAppSpecSchema = z.object({
  appName: stringFieldSchema.optional().nullable(),
  purpose: stringFieldSchema.optional().nullable(),
  appType: appTypeSchema.optional().nullable(),
  targetUsers: stringListSchema.optional(),
  coreFeatures: stringListSchema.optional(),
  dataEntities: stringListSchema.optional(),
  integrations: stringListSchema.optional(),
  authRequired: z.boolean().optional().nullable(),
  deploymentTarget: stringFieldSchema.optional().nullable(),
  roles: stringListSchema.optional(),
  permissions: stringListSchema.optional(),
  reportingNeeds: stringListSchema.optional(),
  workflowSteps: stringListSchema.optional(),
  notes: stringListSchema.optional()
});

const rawPartialAppSpecSchema = z.object({
  appName: z.string().trim().optional().nullable(),
  purpose: z.string().trim().optional().nullable(),
  appType: z.string().trim().optional().nullable(),
  targetUsers: stringListSchema.optional(),
  coreFeatures: stringListSchema.optional(),
  dataEntities: stringListSchema.optional(),
  integrations: stringListSchema.optional(),
  authRequired: z.boolean().optional().nullable(),
  deploymentTarget: z.string().trim().optional().nullable(),
  roles: stringListSchema.optional(),
  permissions: stringListSchema.optional(),
  reportingNeeds: stringListSchema.optional(),
  workflowSteps: stringListSchema.optional(),
  notes: stringListSchema.optional()
});

export const appSpecSchema = z.object({
  appName: stringFieldSchema.optional().nullable(),
  purpose: stringFieldSchema.optional().nullable(),
  appType: appTypeSchema.optional().nullable(),
  targetUsers: stringListSchema.default([]),
  coreFeatures: stringListSchema.default([]),
  dataEntities: stringListSchema.default([]),
  integrations: stringListSchema.default([]),
  authRequired: z.boolean().optional().nullable(),
  deploymentTarget: stringFieldSchema.optional().nullable(),
  roles: stringListSchema.default([]),
  permissions: stringListSchema.default([]),
  reportingNeeds: stringListSchema.default([]),
  workflowSteps: stringListSchema.default([]),
  notes: stringListSchema.default([])
});

export const partialAppSpecSchema = rawPartialAppSpecSchema.transform(normalizePartialAppSpec);

export type AppSpec = z.infer<typeof appSpecSchema>;
export type PartialAppSpec = z.infer<typeof partialAppSpecSchema>;
export type AppSpecField = keyof AppSpec;

export function createEmptyAppSpec(): AppSpec {
  return appSpecSchema.parse({});
}

export function normalizePlatformDeploymentTarget(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (/\b(ios|iphone|ipad)\b/.test(normalized)) {
    return "iOS";
  }

  if (/\bandroid\b/.test(normalized)) {
    return "Android";
  }

  if (/\b(mobile|phone|native app)\b/.test(normalized)) {
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

function normalizePartialAppSpec(rawSpec: z.infer<typeof rawPartialAppSpecSchema>): z.infer<typeof strictPartialAppSpecSchema> {
  const normalized: Record<string, unknown> = { ...rawSpec };
  const deploymentTarget = normalizePlatformDeploymentTarget(rawSpec.appType);
  const appType = normalizeRawAppType(rawSpec.appType);

  removeEmptyStringFields(normalized);

  if (appType === undefined) {
    delete normalized.appType;
  } else {
    normalized.appType = appType;
  }

  if (deploymentTarget && !normalized.deploymentTarget) {
    normalized.deploymentTarget = deploymentTarget;
  }

  return strictPartialAppSpecSchema.parse(normalized);
}

function normalizeRawAppType(value: string | null | undefined): AppType | null | undefined {
  if (value === null || value === undefined) {
    return value;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const directAppType = appTypes.find((candidate) => candidate === normalized);
  if (directAppType) {
    return directAppType;
  }

  const keywordAppType = getKeywordAppType(normalized);
  if (keywordAppType) {
    return keywordAppType;
  }

  if (normalizePlatformDeploymentTarget(normalized)) {
    return undefined;
  }

  return "other";
}

function getKeywordAppType(value: string): AppType | undefined {
  if (/\bdashboard\b|\banalytics\b|\breporting\b/.test(value)) {
    return "dashboard";
  }

  if (/\bworkflow\b|\bapproval\b|\bprocess\b/.test(value)) {
    return "workflow";
  }

  if (/\bcrud\b|\brecords?\b|\bdata entry\b/.test(value)) {
    return "crud";
  }

  if (/\bchatbot\b|\bchat bot\b|\bassistant\b|\bconversational\b/.test(value)) {
    return "chatbot";
  }

  if (/\bportal\b/.test(value)) {
    return "portal";
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
