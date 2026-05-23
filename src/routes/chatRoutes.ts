import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { TicketingSystemClient } from "../ticketingSystem/ticketingSystemClient";
import {
  defaultContextWindowOptions,
  getContextWindowUsage,
  type ContextWindowOptions
} from "../domain/contextWindow";
import { createConversationState, type ConversationState } from "../domain/conversationState";
import type { UserPreferences } from "../domain/userPreferences";
import type { LlmClient } from "../llm/llmClient";
import { createCompositeTelemetry, createLoggerTelemetry, getErrorAttributes, type Telemetry } from "../observability/telemetry";
import type { TicketCommandRepository } from "../persistence/ticketCommandRepository";
import type { ConversationRepository } from "../persistence/conversationRepository";
import type { UserPreferencesRepository } from "../persistence/userPreferencesRepository";
import { redactSensitiveValue } from "../privacy/redaction";
import { getRequiredFieldsForSpec } from "../domain/validation";
import type { TicketCommandRecord } from "../workflow/ticketCommand";
import { handleChatTurn } from "../workflow/handleChatTurn";

const routeIdSchema = z.string().trim().min(1).max(200);

const chatRequestSchema = z.object({
  conversationId: routeIdSchema,
  userId: routeIdSchema.optional().nullable(),
  message: z.string().trim().min(1).max(8000)
}).strict();

const conversationParamsSchema = z.object({
  conversationId: routeIdSchema
}).strict();

export interface ChatRouteDependencies {
  repository: ConversationRepository;
  userPreferencesRepository?: UserPreferencesRepository;
  commandRepository?: TicketCommandRepository;
  llmClient: LlmClient;
  ticketingSystem: TicketingSystemClient;
  contextWindow?: ContextWindowOptions;
  telemetry?: Telemetry;
}

export async function registerChatRoutes(server: FastifyInstance, dependencies: ChatRouteDependencies): Promise<void> {
  const contextWindow = dependencies.contextWindow ?? defaultContextWindowOptions;

  server.get("/api/conversations/:conversationId", async (request, reply) => {
    const parsed = conversationParamsSchema.safeParse(request.params);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid conversation request.",
        details: parsed.error.flatten()
      });
    }

    let state: ConversationState | undefined;
    try {
      state = await dependencies.repository.get(parsed.data.conversationId);
    } catch (error) {
      request.log.error({ error: getErrorAttributes(error), conversationId: parsed.data.conversationId }, "Conversation load failed");
      return reply.code(500).send({ error: "The conversation could not be loaded." });
    }

    if (!state) {
      return reply.send(serializeConversationState(createConversationState(parsed.data.conversationId), contextWindow));
    }

    const [userPreferences, commands] = await Promise.all([
      state.userId && dependencies.userPreferencesRepository
        ? dependencies.userPreferencesRepository.get(state.userId)
        : undefined,
      dependencies.commandRepository?.listByConversationId(state.conversationId)
    ]);

    return reply.send(serializeConversationState(state, contextWindow, userPreferences, commands));
  });

  server.post("/api/chat", async (request, reply) => {
    const parsed = chatRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid chat request.",
        details: parsed.error.flatten()
      });
    }

    try {
      const telemetry = dependencies.telemetry
        ? createCompositeTelemetry(createLoggerTelemetry(request.log), dependencies.telemetry)
        : createLoggerTelemetry(request.log);

      const response = await handleChatTurn({
        ...parsed.data,
        repository: dependencies.repository,
        userPreferencesRepository: dependencies.userPreferencesRepository,
        commandRepository: dependencies.commandRepository,
        llmClient: dependencies.llmClient,
        ticketingSystem: dependencies.ticketingSystem,
        contextWindow,
        telemetry
      });

      return reply.send(response);
    } catch (error) {
      request.log.error({ error: getErrorAttributes(error), conversationId: parsed.data.conversationId, userId: parsed.data.userId ?? null }, "Chat turn failed");
      return reply.code(500).send({
        error: "The chatbot could not process the message."
      });
    }
  });
}

function serializeConversationState(
  state: ConversationState,
  contextWindow: ContextWindowOptions,
  userPreferences?: UserPreferences,
  commands?: TicketCommandRecord[]
) {
  const safeState = redactSensitiveValue(state).value;
  const safeUserPreferences = userPreferences ? redactSensitiveValue(userPreferences).value : undefined;
  const safeCommands = commands ? redactSensitiveValue(commands).value : undefined;

  return {
    conversationId: safeState.conversationId,
    status: safeState.status,
    messages: safeState.messages,
    ticketSpec: safeState.ticketSpec,
    missingFields: safeState.missingFields,
    requiredFields: getRequiredFieldsForSpec(safeState.ticketSpec),
    contextWindow: getContextWindowUsage(safeState, contextWindow),
    createdTicket: safeState.createdTicketId && safeState.createdTicketUrl ? {
      ticketId: safeState.createdTicketId,
      url: safeState.createdTicketUrl
    } : undefined,
    userPreferences: safeUserPreferences,
    commands: safeCommands
  };
}

