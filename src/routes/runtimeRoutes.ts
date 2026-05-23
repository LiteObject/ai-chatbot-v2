import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../config";

export async function registerRuntimeRoutes(server: FastifyInstance, config: AppConfig): Promise<void> {
  server.get("/api/runtime", async () => ({
    contextWindowTokens: config.ollamaContextWindowTokens,
    contextWindowWarningRatio: config.ollamaContextWindowWarningRatio,
    contextWindowBlockRatio: config.ollamaContextWindowBlockRatio,
    modelId: config.ollamaModel
  }));
}