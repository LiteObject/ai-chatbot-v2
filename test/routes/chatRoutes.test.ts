import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AppBuilderClient } from "../../src/appBuilder/appBuilderClient";
import { appendMessage, createConversationState } from "../../src/domain/conversationState";
import { createUserPreferences } from "../../src/domain/userPreferences";
import type { LlmClient } from "../../src/llm/llmClient";
import { InMemoryAppCommandRepository } from "../../src/persistence/inMemoryAppCommandRepository";
import { InMemoryConversationRepository } from "../../src/persistence/inMemoryConversationRepository";
import { InMemoryUserPreferencesRepository } from "../../src/persistence/inMemoryUserPreferencesRepository";
import { registerChatRoutes } from "../../src/routes/chatRoutes";
import { createPlannedAppCommandRecord, type CreateAppCommand } from "../../src/workflow/appCommand";

const llmClient: LlmClient = {
  async extractAppSpec() {
    return {};
  },
  async generateClarifyingQuestion() {
    return "Missing details.";
  },
  async generateConfirmationSummary() {
    return "Ready to create this app?";
  }
};

const appBuilder: AppBuilderClient = {
  async createApp() {
    return {
      status: "created",
      appId: "app_test_1",
      url: "http://localhost/apps/app_test_1"
    };
  }
};

describe("chat routes", () => {
  it("returns saved conversation state", async () => {
    const server = fastify();
    const repository = new InMemoryConversationRepository();
    const userPreferencesRepository = new InMemoryUserPreferencesRepository();
    const commandRepository = new InMemoryAppCommandRepository();
    const state = createConversationState("conv_1", "user_1");

    state.status = "awaiting_confirmation";
    state.appSpec = {
      ...state.appSpec,
      purpose: "Take survey",
      appType: "other",
      targetUsers: ["Students", "Learners"],
      coreFeatures: ["Survey completion"]
    };
    state.missingFields = [];
    appendMessage(state, "user", "I want to build a mobile app");
    appendMessage(state, "assistant", "Should we proceed with creating this app now?");
    await repository.save(state);
    await userPreferencesRepository.save({
      ...createUserPreferences("user_1", "2026-05-18T00:00:00.000Z"),
      preferredAppType: "other",
      preferredDeploymentTarget: "mobile"
    });
    await commandRepository.save(createPlannedAppCommandRecord(createCommand(state)));

    await registerChatRoutes(server, {
      repository,
      userPreferencesRepository,
      commandRepository,
      llmClient,
      appBuilder
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/conversations/conv_1"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      conversationId: "conv_1",
      status: "awaiting_confirmation",
      appSpec: {
        purpose: "Take survey",
        targetUsers: ["Students", "Learners"],
        coreFeatures: ["Survey completion"]
      },
      missingFields: [],
      requiredFields: ["appType", "purpose", "targetUsers", "coreFeatures"],
      contextWindow: {
        status: "ok"
      },
      userPreferences: {
        preferredAppType: "other",
        preferredDeploymentTarget: "mobile"
      },
      commands: [
        {
          status: "planned",
          command: {
            id: "create_app:conv_1:test",
            idempotencyKey: "create_app:conv_1:test",
            type: "create_app"
          }
        }
      ]
    });
  });

  it("redacts sensitive values from saved conversation responses", async () => {
    const server = fastify();
    const repository = new InMemoryConversationRepository();
    const commandRepository = new InMemoryAppCommandRepository();
    const state = createConversationState("conv_sensitive", "user_1");

    state.status = "awaiting_confirmation";
    state.appSpec = {
      ...state.appSpec,
      purpose: "Call legacy API with apiKey=super-secret-123",
      appType: "other",
      targetUsers: ["admin@example.com"],
      coreFeatures: ["API lookup"]
    };
    state.missingFields = [];
    appendMessage(state, "user", "Use token=secret-token-123 for admin@example.com");
    await repository.save(state);
    await commandRepository.save(createPlannedAppCommandRecord(createCommand(state)));

    await registerChatRoutes(server, {
      repository,
      commandRepository,
      llmClient,
      appBuilder
    });

    const response = await server.inject({
      method: "GET",
      url: "/api/conversations/conv_sensitive"
    });
    const body = response.json();
    const serializedBody = JSON.stringify(body);

    expect(response.statusCode).toBe(200);
    expect(serializedBody).toContain("[REDACTED:email]");
    expect(serializedBody).toContain("apiKey=[REDACTED:labeled_secret]");
    expect(serializedBody).toContain("token=[REDACTED:labeled_secret]");
    expect(serializedBody).not.toContain("admin@example.com");
    expect(serializedBody).not.toContain("super-secret-123");
    expect(serializedBody).not.toContain("secret-token-123");
  });

  it("returns 404 for unknown conversations", async () => {
    const server = fastify();
    const repository = new InMemoryConversationRepository();

    await registerChatRoutes(server, { repository, llmClient, appBuilder });

    const response = await server.inject({
      method: "GET",
      url: "/api/conversations/missing"
    });

    expect(response.statusCode).toBe(404);
  });

  it("rejects chat requests with unexpected fields", async () => {
    const server = fastify();
    const repository = new InMemoryConversationRepository();

    await registerChatRoutes(server, { repository, llmClient, appBuilder });

    const response = await server.inject({
      method: "POST",
      url: "/api/chat",
      payload: {
        conversationId: "conv_1",
        userId: "user_1",
        message: "Build an app.",
        createNow: true
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Invalid chat request."
    });
  });
});

function createCommand(state: ReturnType<typeof createConversationState>): CreateAppCommand {
  return {
    id: "create_app:conv_1:test",
    type: "create_app",
    idempotencyKey: "create_app:conv_1:test",
    conversationId: state.conversationId,
    requestedBy: state.userId ?? null,
    appSpec: state.appSpec,
    riskLevel: "high",
    approvalRequired: true,
    approval: {
      status: "approved",
      approvedBy: state.userId ?? null,
      approvedAt: "2026-05-18T00:00:00.000Z",
      source: "explicit_user_confirmation"
    },
    plannedAt: "2026-05-18T00:00:00.000Z"
  };
}