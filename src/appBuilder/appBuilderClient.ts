import { z } from "zod";
import { appSpecSchema } from "../domain/appSpec";

const appBuilderStringSchema = z.string().trim().min(1).max(500);

export const createAppRequestSchema = z.object({
  idempotencyKey: appBuilderStringSchema,
  conversationId: appBuilderStringSchema,
  requestedBy: appBuilderStringSchema.optional().nullable(),
  appSpec: appSpecSchema
}).strict();

export const createAppResultSchema = z.object({
  status: z.literal("created"),
  appId: appBuilderStringSchema,
  url: z.string().trim().url().max(2000)
}).strict();

export type CreateAppRequest = z.infer<typeof createAppRequestSchema>;
export type CreateAppResult = z.infer<typeof createAppResultSchema>;

export interface AppBuilderClient {
  createApp(request: CreateAppRequest): Promise<CreateAppResult>;
}
