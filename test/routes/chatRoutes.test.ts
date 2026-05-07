import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AppBuilderClient } from "../../src/appBuilder/appBuilderClient";
import { appendMessage, createConversationState } from "../../src/domain/conversationState";
import type { ConfirmationDecision } from "../../src/domain/confirmation";
import type { LlmClient } from "../../src/llm/llmClient";
import { InMemoryConversationRepository } from "../../src/persistence/inMemoryConversationRepository";
import { registerChatRoutes } from "../../src/routes/chatRoutes";

const llmClient: LlmClient = {
  async extractAppSpec() {
    return {};
  },
  async generateClarifyingQuestion() {
    return "Missing details.";
  },
  async generateConfirmationSummary() {
    return "Ready to create this app?";
  },
  async classifyConfirmation(): Promise<ConfirmationDecision> {
    return "ambiguous";
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

    await registerChatRoutes(server, { repository, llmClient, appBuilder });

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
      }
    });
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
});