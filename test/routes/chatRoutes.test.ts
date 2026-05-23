import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { TicketingSystemClient } from "../../src/ticketingSystem/ticketingSystemClient";
import { appendMessage, createConversationState } from "../../src/domain/conversationState";
import { createUserPreferences } from "../../src/domain/userPreferences";
import type { LlmClient } from "../../src/llm/llmClient";
import { InMemoryTicketCommandRepository } from "../../src/persistence/inMemoryTicketCommandRepository";
import { InMemoryConversationRepository } from "../../src/persistence/inMemoryConversationRepository";
import { InMemoryUserPreferencesRepository } from "../../src/persistence/inMemoryUserPreferencesRepository";
import { registerChatRoutes } from "../../src/routes/chatRoutes";
import { createPlannedTicketCommandRecord, type CreateTicketCommand } from "../../src/workflow/ticketCommand";

const llmClient: LlmClient = {
    async extractTicketSpec() {
        return {};
    },
    async generateClarifyingQuestion() {
        return "Missing details.";
    },
    async generateConfirmationSummary() {
        return "Ready to create this ticket?";
    }
};

const ticketingSystem: TicketingSystemClient = {
    async createTicket() {
        return {
            status: "created",
            ticketId: "ticket_test_1",
            url: "http://localhost/tickets/ticket_test_1"
        };
    }
};

describe("chat routes", () => {
    it("returns saved conversation state", async () => {
        const server = fastify();
        const repository = new InMemoryConversationRepository();
        const userPreferencesRepository = new InMemoryUserPreferencesRepository();
        const commandRepository = new InMemoryTicketCommandRepository();
        const state = createConversationState("conv_1", "user_1");

        state.status = "awaiting_confirmation";
        state.ticketSpec = {
            ...state.ticketSpec,
            summary: "Reset VPN access for contractors",
            ticketType: "request",
            affectedUsers: ["contractors"],
            affectedServices: ["vpn"],
            details: ["restore VPN access"],
            environment: "web"
        };
        state.missingFields = [];
        appendMessage(state, "user", "I need VPN access for contractors.");
        appendMessage(state, "assistant", "Ready to create this ticket?");
        await repository.save(state);
        await userPreferencesRepository.save({
            ...createUserPreferences("user_1", "2026-05-18T00:00:00.000Z"),
            preferredTicketType: "request",
            preferredEnvironment: "web",
            preferredAffectedServices: ["vpn"]
        });
        await commandRepository.save(createPlannedTicketCommandRecord(createCommand(state)));

        await registerChatRoutes(server, {
            repository,
            userPreferencesRepository,
            commandRepository,
            llmClient,
            ticketingSystem
        });

        const response = await server.inject({
            method: "GET",
            url: "/api/conversations/conv_1"
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            conversationId: "conv_1",
            status: "awaiting_confirmation",
            ticketSpec: {
                summary: "Reset VPN access for contractors",
                affectedUsers: ["contractors"],
                affectedServices: ["vpn"],
                details: ["restore VPN access"]
            },
            missingFields: [],
            requiredFields: ["ticketType", "summary", "affectedUsers", "affectedServices", "details"],
            userPreferences: {
                preferredTicketType: "request",
                preferredEnvironment: "web",
                preferredAffectedServices: ["vpn"]
            },
            commands: [
                {
                    status: "planned",
                    command: {
                        id: "create_ticket:conv_1:test",
                        idempotencyKey: "create_ticket:conv_1:test",
                        type: "create_ticket"
                    }
                }
            ]
        });
    });

    it("redacts sensitive values from saved conversation responses", async () => {
        const server = fastify();
        const repository = new InMemoryConversationRepository();
        const commandRepository = new InMemoryTicketCommandRepository();
        const state = createConversationState("conv_sensitive", "user_1");

        state.status = "awaiting_confirmation";
        state.ticketSpec = {
            ...state.ticketSpec,
            summary: "Reset VPN access with apiKey=super-secret-123",
            ticketType: "request",
            affectedUsers: ["admin@example.com"],
            affectedServices: ["vpn"],
            details: ["restore VPN access"]
        };
        state.missingFields = [];
        appendMessage(state, "user", "Use token=secret-token-123 for admin@example.com");
        await repository.save(state);
        await commandRepository.save(createPlannedTicketCommandRecord(createCommand(state)));

        await registerChatRoutes(server, {
            repository,
            commandRepository,
            llmClient,
            ticketingSystem
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

    it("returns an empty conversation state for unknown conversations", async () => {
        const server = fastify();
        const repository = new InMemoryConversationRepository();

        await registerChatRoutes(server, { repository, llmClient, ticketingSystem });

        const response = await server.inject({
            method: "GET",
            url: "/api/conversations/missing"
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            conversationId: "missing",
            status: "collecting_requirements",
            messages: [],
            ticketSpec: {
                affectedUsers: [],
                affectedServices: [],
                details: [],
                reproductionSteps: [],
                notes: []
            },
            missingFields: [],
            requiredFields: ["ticketType", "summary"]
        });
    });

    it("rejects chat requests with unexpected fields", async () => {
        const server = fastify();
        const repository = new InMemoryConversationRepository();

        await registerChatRoutes(server, { repository, llmClient, ticketingSystem });

        const response = await server.inject({
            method: "POST",
            url: "/api/chat",
            payload: {
                conversationId: "conv_1",
                userId: "user_1",
                message: "I need VPN access.",
                createNow: true
            }
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
            error: "Invalid chat request."
        });
    });
});

function createCommand(state: ReturnType<typeof createConversationState>): CreateTicketCommand {
    return {
        id: "create_ticket:conv_1:test",
        type: "create_ticket",
        idempotencyKey: "create_ticket:conv_1:test",
        conversationId: state.conversationId,
        requestedBy: state.userId ?? null,
        ticketSpec: state.ticketSpec,
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