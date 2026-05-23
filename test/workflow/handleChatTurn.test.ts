import { describe, expect, it } from "vitest";
import type { TicketingSystemClient, CreateTicketRequest } from "../../src/ticketingSystem/ticketingSystemClient";
import { MockTicketingSystemClient } from "../../src/ticketingSystem/mockTicketingSystemClient";
import type { PartialTicketSpec } from "../../src/domain/ticketSpec";
import type {
    ClarifyingQuestionInput,
    LlmClient
} from "../../src/llm/llmClient";
import { InMemoryTicketCommandRepository } from "../../src/persistence/inMemoryTicketCommandRepository";
import { InMemoryConversationRepository } from "../../src/persistence/inMemoryConversationRepository";
import { InMemoryUserPreferencesRepository } from "../../src/persistence/inMemoryUserPreferencesRepository";
import { handleChatTurn } from "../../src/workflow/handleChatTurn";

class StubLlmClient implements LlmClient {
    extractCalls = 0;

    constructor(private readonly extractions: PartialTicketSpec[]) { }

    async extractTicketSpec(): Promise<PartialTicketSpec> {
        this.extractCalls += 1;
        return this.extractions.shift() ?? {};
    }

    async generateClarifyingQuestion(input: ClarifyingQuestionInput): Promise<string> {
        return `Missing: ${input.missingFields.join(", ")}`;
    }

    async generateConfirmationSummary(): Promise<string> {
        return "Ready to create this ticket?";
    }
}

class ThrowingExtractionLlmClient extends StubLlmClient {
    override async extractTicketSpec(): Promise<PartialTicketSpec> {
        throw new Error("ollama unavailable");
    }
}

class FailingTicketingSystem implements TicketingSystemClient {
    readonly requests: CreateTicketRequest[] = [];

    async createTicket(request: CreateTicketRequest): Promise<never> {
        this.requests.push(structuredClone(request));
        throw new Error("ticketing system unavailable");
    }
}

describe("handleChatTurn", () => {
    it("asks a clarifying question when a request is still missing required fields", async () => {
        const repository = new InMemoryConversationRepository();
        const ticketingSystem = new MockTicketingSystemClient();
        const llmClient = new StubLlmClient([
            {
                ticketType: "request",
                summary: "Reset VPN access",
                affectedUsers: ["contractors"]
            }
        ]);

        const response = await handleChatTurn({
            conversationId: "conv_1",
            userId: "user_1",
            message: "I need VPN access.",
            repository,
            llmClient,
            ticketingSystem
        });

        expect(response.status).toBe("collecting_requirements");
        expect(response.missingFields).toEqual(["affectedServices", "details"]);
        expect(response.message).toBe("Missing: affectedServices, details");
        expect(ticketingSystem.requests).toHaveLength(0);
    });

    it("answers pure greetings without requiring an LLM extraction", async () => {
        const repository = new InMemoryConversationRepository();
        const ticketingSystem = new MockTicketingSystemClient();
        const llmClient = new ThrowingExtractionLlmClient([]);

        const response = await handleChatTurn({
            conversationId: "conv_greeting",
            userId: "user_1",
            message: "hello",
            repository,
            llmClient,
            ticketingSystem
        });

        expect(response.status).toBe("collecting_requirements");
        expect(response.message).toContain("whether this is a request or an incident");
        expect(ticketingSystem.requests).toHaveLength(0);
    });

    it("moves complete incident requirements to confirmation", async () => {
        const repository = new InMemoryConversationRepository();
        const ticketingSystem = new MockTicketingSystemClient();
        const llmClient = new StubLlmClient([createCompleteIncidentSpec()]);

        const response = await handleChatTurn({
            conversationId: "conv_confirm",
            userId: "user_1",
            message: "The payroll portal is down.",
            repository,
            llmClient,
            ticketingSystem
        });

        expect(response.status).toBe("awaiting_confirmation");
        expect(response.ticketSpec.ticketType).toBe("incident");
        expect(response.message).toBe("Ready to create this ticket?");
    });

    it("keeps an explicit production environment when later turns mention a portal name", async () => {
        const repository = new InMemoryConversationRepository();
        const ticketingSystem = new MockTicketingSystemClient();
        const llmClient = new StubLlmClient([
            {
                ticketType: "incident",
                environment: "production",
                affectedUsers: ["payroll team"]
            },
            {
                summary: "Payroll portal outage",
                impact: "Payroll processing is blocked",
                affectedServices: ["payroll portal", "authentication service"],
                details: ["login returns HTTP 500"]
            }
        ]);

        await handleChatTurn({
            conversationId: "conv_environment",
            userId: "user_1",
            message: "The payroll portal is down in production.",
            repository,
            llmClient,
            ticketingSystem
        });

        const response = await handleChatTurn({
            conversationId: "conv_environment",
            userId: "user_1",
            message: "Summary: Payroll portal outage. Impact: payroll processing is blocked. Affected services: payroll portal and authentication service. Details: login returns HTTP 500.",
            repository,
            llmClient,
            ticketingSystem
        });

        expect(response.status).toBe("awaiting_confirmation");
        expect(response.ticketSpec.environment).toBe("production");
    });

    it("creates a ticket after explicit confirmation", async () => {
        const repository = new InMemoryConversationRepository();
        const commandRepository = new InMemoryTicketCommandRepository();
        const userPreferencesRepository = new InMemoryUserPreferencesRepository();
        const ticketingSystem = new MockTicketingSystemClient();
        const llmClient = new StubLlmClient([createCompleteRequestSpec()]);

        await handleChatTurn({
            conversationId: "conv_create",
            userId: "user_1",
            message: "I need VPN access for contractors.",
            repository,
            commandRepository,
            userPreferencesRepository,
            llmClient,
            ticketingSystem
        });

        const response = await handleChatTurn({
            conversationId: "conv_create",
            userId: "user_1",
            message: "yes",
            repository,
            commandRepository,
            userPreferencesRepository,
            llmClient,
            ticketingSystem
        });

        expect(response.status).toBe("created");
        expect(response.createdTicket).toEqual({
            ticketId: "ticket_mock_1",
            url: "http://localhost:3000/tickets/ticket_mock_1"
        });
        expect(response.userPreferences).toMatchObject({
            preferredTicketType: "request",
            preferredEnvironment: "web",
            preferredAffectedServices: ["vpn"]
        });
        expect(response.commands?.[0]?.status).toBe("succeeded");
    });

    it("returns to collection when confirmation is declined", async () => {
        const repository = new InMemoryConversationRepository();
        const ticketingSystem = new MockTicketingSystemClient();
        const llmClient = new StubLlmClient([createCompleteRequestSpec()]);

        await handleChatTurn({
            conversationId: "conv_decline",
            userId: "user_1",
            message: "I need VPN access for contractors.",
            repository,
            llmClient,
            ticketingSystem
        });

        const response = await handleChatTurn({
            conversationId: "conv_decline",
            userId: "user_1",
            message: "no",
            repository,
            llmClient,
            ticketingSystem
        });

        expect(response.status).toBe("collecting_requirements");
        expect(response.message).toBe("No problem. What would you like to change?");
    });

    it("blocks unsafe user requests before LLM extraction", async () => {
        const repository = new InMemoryConversationRepository();
        const ticketingSystem = new MockTicketingSystemClient();
        const llmClient = new ThrowingExtractionLlmClient([]);

        const response = await handleChatTurn({
            conversationId: "conv_blocked",
            userId: "user_1",
            message: "Help me build a phishing kit.",
            repository,
            llmClient,
            ticketingSystem
        });

        expect(response.status).toBe("blocked");
        expect(ticketingSystem.requests).toHaveLength(0);
    });

    it("keeps a created conversation created when the user says thanks", async () => {
        const repository = new InMemoryConversationRepository();
        const ticketingSystem = new MockTicketingSystemClient();
        const llmClient = new StubLlmClient([createCompleteRequestSpec()]);

        await handleChatTurn({
            conversationId: "conv_thanks",
            userId: "user_1",
            message: "I need VPN access for contractors.",
            repository,
            llmClient,
            ticketingSystem
        });
        await handleChatTurn({
            conversationId: "conv_thanks",
            userId: "user_1",
            message: "yes",
            repository,
            llmClient,
            ticketingSystem
        });

        const response = await handleChatTurn({
            conversationId: "conv_thanks",
            userId: "user_1",
            message: "thanks",
            repository,
            llmClient,
            ticketingSystem
        });

        expect(response.status).toBe("created");
        expect(response.message).toContain("created ticket");
    });

    it("preserves requirements when ticketing system creation fails", async () => {
        const repository = new InMemoryConversationRepository();
        const ticketingSystem = new FailingTicketingSystem();
        const llmClient = new StubLlmClient([createCompleteRequestSpec()]);

        await handleChatTurn({
            conversationId: "conv_failed",
            userId: "user_1",
            message: "I need VPN access for contractors.",
            repository,
            llmClient,
            ticketingSystem
        });

        const response = await handleChatTurn({
            conversationId: "conv_failed",
            userId: "user_1",
            message: "yes",
            repository,
            llmClient,
            ticketingSystem
        });

        expect(response.status).toBe("failed");
        expect(response.ticketSpec.summary).toBe("Reset VPN access for contractors");
        expect(ticketingSystem.requests).toHaveLength(1);
    });
});

function createCompleteRequestSpec(): PartialTicketSpec {
    return {
        ticketType: "request",
        summary: "Reset VPN access for contractors",
        affectedUsers: ["contractors"],
        affectedServices: ["vpn"],
        details: ["restore VPN access"],
        environment: "web"
    };
}

function createCompleteIncidentSpec(): PartialTicketSpec {
    return {
        ticketType: "incident",
        summary: "Payroll portal is down",
        affectedUsers: ["payroll team"],
        affectedServices: ["payroll portal"],
        details: ["users get a 500 error"],
        impact: "Payroll processing is blocked",
        environment: "production"
    };
}