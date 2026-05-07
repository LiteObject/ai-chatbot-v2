import fastify from "fastify";
import type { AppBuilderClient } from "./appBuilder/appBuilderClient";
import { MockAppBuilderClient } from "./appBuilder/mockAppBuilderClient";
import type { AppConfig } from "./config";
import type { ContextWindowOptions } from "./domain/contextWindow";
import { BedrockLlmClient } from "./llm/bedrockLlmClient";
import type { LlmClient } from "./llm/llmClient";
import { InMemoryTelemetryAggregator } from "./observability/inMemoryTelemetryAggregator";
import { createLoggerOptions } from "./observability/logger";
import { createCompositeTelemetry, createLoggerTelemetry } from "./observability/telemetry";
import { InMemoryConversationRepository } from "./persistence/inMemoryConversationRepository";
import type { ConversationRepository } from "./persistence/conversationRepository";
import { registerChatRoutes } from "./routes/chatRoutes";
import { registerMetricsRoutes } from "./routes/metricsRoutes";
import { registerRuntimeRoutes } from "./routes/runtimeRoutes";
import { registerUiRoutes } from "./routes/uiRoutes";

export interface BuildAppOptions {
  config: AppConfig;
  repository?: ConversationRepository;
  llmClient?: LlmClient;
  appBuilder?: AppBuilderClient;
  metrics?: InMemoryTelemetryAggregator;
}

export async function buildApp(options: BuildAppOptions) {
  const server = fastify({ logger: createLoggerOptions(options.config) });
  const repository = options.repository ?? new InMemoryConversationRepository();
  const metrics = options.metrics ?? new InMemoryTelemetryAggregator();
  const telemetry = createCompositeTelemetry(createLoggerTelemetry(server.log), metrics);
  const llmClient = options.llmClient ?? new BedrockLlmClient(options.config, telemetry);
  const appBuilder = options.appBuilder ?? new MockAppBuilderClient();
  const contextWindow: ContextWindowOptions = {
    maxTokens: options.config.bedrockContextWindowTokens,
    warningRatio: options.config.bedrockContextWindowWarningRatio,
    blockRatio: options.config.bedrockContextWindowBlockRatio
  };

  server.get("/health", async () => ({ status: "ok" }));

  await registerRuntimeRoutes(server, options.config);
  await registerMetricsRoutes(server, { metrics });
  await registerChatRoutes(server, { repository, llmClient, appBuilder, contextWindow, telemetry: metrics });
  await registerUiRoutes(server);

  return server;
}
