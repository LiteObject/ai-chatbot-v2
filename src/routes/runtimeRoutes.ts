import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config";

export async function registerRuntimeRoutes(server: FastifyInstance, config: AppConfig): Promise<void> {
  server.get("/api/runtime", async () => ({
    contextWindowTokens: config.bedrockContextWindowTokens,
    contextWindowWarningRatio: config.bedrockContextWindowWarningRatio,
    contextWindowBlockRatio: config.bedrockContextWindowBlockRatio,
    modelId: config.bedrockModelId
  }));
}