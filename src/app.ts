import fastify from "fastify";
import type { TicketingSystemClient } from "./ticketingSystem/ticketingSystemClient";
import { MockTicketingSystemClient } from "./ticketingSystem/mockTicketingSystemClient";
import type { AppConfig } from "./config";
import type { ContextWindowOptions } from "./domain/contextWindow";
import { OllamaLlmClient } from "./llm/ollamaLlmClient";
import type { LlmClient } from "./llm/llmClient";
import { InMemoryTelemetryAggregator } from "./observability/inMemoryTelemetryAggregator";
import { createLoggerOptions } from "./observability/logger";
import { createCompositeTelemetry, createLoggerTelemetry } from "./observability/telemetry";
import type { TicketCommandRepository } from "./persistence/ticketCommandRepository";
import { InMemoryConversationRepository } from "./persistence/inMemoryConversationRepository";
import { InMemoryTicketCommandRepository } from "./persistence/inMemoryTicketCommandRepository";
import { InMemoryUserPreferencesRepository } from "./persistence/inMemoryUserPreferencesRepository";
import type { ConversationRepository } from "./persistence/conversationRepository";
import type { UserPreferencesRepository } from "./persistence/userPreferencesRepository";
import { registerChatRoutes } from "./routes/chatRoutes";
import { registerMetricsRoutes } from "./routes/metricsRoutes";
import { registerRuntimeRoutes } from "./routes/runtimeRoutes";
import { registerUiRoutes } from "./routes/uiRoutes";

export interface BuildAppOptions {
  config: AppConfig;
  repository?: ConversationRepository;
  userPreferencesRepository?: UserPreferencesRepository;
  commandRepository?: TicketCommandRepository;
  llmClient?: LlmClient;
  ticketingSystem?: TicketingSystemClient;
  metrics?: InMemoryTelemetryAggregator;
}

export async function buildApp(options: BuildAppOptions) {
  const server = fastify({ logger: createLoggerOptions(options.config) });
  const repository = options.repository ?? new InMemoryConversationRepository();
  const userPreferencesRepository = options.userPreferencesRepository ?? new InMemoryUserPreferencesRepository();
  const commandRepository = options.commandRepository ?? new InMemoryTicketCommandRepository();
  const metrics = options.metrics ?? new InMemoryTelemetryAggregator();
  const telemetry = createCompositeTelemetry(createLoggerTelemetry(server.log), metrics);
  const llmClient = options.llmClient ?? new OllamaLlmClient(options.config, telemetry);
  const ticketingSystem = options.ticketingSystem ?? new MockTicketingSystemClient();
  const contextWindow: ContextWindowOptions = {
    maxTokens: options.config.ollamaContextWindowTokens,
    warningRatio: options.config.ollamaContextWindowWarningRatio,
    blockRatio: options.config.ollamaContextWindowBlockRatio
  };

  server.get("/health", async () => ({ status: "ok" }));

  await registerRuntimeRoutes(server, options.config);
  await registerMetricsRoutes(server, { metrics });
  await registerChatRoutes(server, {
    repository,
    userPreferencesRepository,
    commandRepository,
    llmClient,
    ticketingSystem,
    contextWindow,
    telemetry: metrics
  });
  await registerUiRoutes(server);

  return server;
}

