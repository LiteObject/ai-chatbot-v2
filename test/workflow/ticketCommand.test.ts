import { describe, expect, it } from "vitest";
import type { TicketingSystemClient, CreateTicketRequest } from "../../src/ticketingSystem/ticketingSystemClient";
import { createEmptyTicketSpec, type TicketSpec } from "../../src/domain/ticketSpec";
import { createConversationState } from "../../src/domain/conversationState";
import type { Telemetry, TelemetryAttributes } from "../../src/observability/telemetry";
import { InMemoryTicketCommandRepository } from "../../src/persistence/inMemoryTicketCommandRepository";
import { executeCreateTicketCommand } from "../../src/workflow/ticketCommandExecutor";
import { planCreateTicketCommand, type CreateTicketCommand } from "../../src/workflow/ticketCommand";

class RecordingTicketingSystem implements TicketingSystemClient {
    readonly requests: CreateTicketRequest[] = [];

    async createTicket(request: CreateTicketRequest) {
        this.requests.push(structuredClone(request));
        return {
            status: "created" as const,
            ticketId: "ticket_test_1",
            url: "http://localhost/tickets/ticket_test_1"
        };
    }
}

class TransientThenSuccessfulTicketingSystem implements TicketingSystemClient {
    readonly requests: CreateTicketRequest[] = [];

    constructor(private failuresRemaining: number) { }

    async createTicket(request: CreateTicketRequest) {
        this.requests.push(structuredClone(request));

        if (this.failuresRemaining > 0) {
            this.failuresRemaining -= 1;
            throw Object.assign(new Error("temporarily unavailable"), {
                name: "ServiceUnavailableException"
            });
        }

        return {
            status: "created" as const,
            ticketId: "ticket_retry_1",
            url: "http://localhost/tickets/ticket_retry_1"
        };
    }
}

class SensitiveResultTicketingSystem implements TicketingSystemClient {
    readonly requests: CreateTicketRequest[] = [];

    async createTicket(request: CreateTicketRequest) {
        this.requests.push(structuredClone(request));
        return {
            status: "created" as const,
            ticketId: "ticket_sensitive_1",
            url: "http://localhost/tickets/ticket_sensitive_1?token=secret-token-123"
        };
    }
}

interface RecordedTelemetryRecord {
    name: string;
    attributes?: TelemetryAttributes;
}

class RecordingTelemetry implements Telemetry {
    readonly events: RecordedTelemetryRecord[] = [];
    readonly metrics: Array<RecordedTelemetryRecord & { value: number }> = [];

    event(name: string, attributes?: TelemetryAttributes): void {
        this.events.push({ name, attributes });
    }

    metric(name: string, value: number, attributes?: TelemetryAttributes): void {
        this.metrics.push({ name, value, attributes });
    }
}

describe("ticket commands", () => {
    it("plans a create-ticket command from confirmed ready state", () => {
        const state = createConversationState("conv_plan", "user_1");
        state.status = "creating_ticket";
        state.confirmed = true;
        state.readyToBuild = true;
        state.ticketSpec = createCompleteRequestSpec();

        const command = planCreateTicketCommand(state);

        expect(command.id).toMatch(/^create_ticket:conv_plan:[a-f0-9]{16}$/);
        expect(command.idempotencyKey).toBe(command.id);
        expect(command).toMatchObject({
            type: "create_ticket",
            conversationId: "conv_plan",
            requestedBy: "user_1",
            ticketSpec: createCompleteRequestSpec()
        });

        state.ticketSpec.affectedUsers.push("finance team");
        expect(command.ticketSpec.affectedUsers).toEqual(["contractors"]);
    });

    it("refuses to plan ticket creation before explicit confirmation", () => {
        const state = createConversationState("conv_unconfirmed", "user_1");
        state.status = "creating_ticket";
        state.readyToBuild = true;
        state.ticketSpec = createCompleteRequestSpec();

        expect(() => planCreateTicketCommand(state)).toThrow("before explicit confirmation");
    });

    it("executes a valid create-ticket command through the ticketing system", async () => {
        const ticketingSystem = new RecordingTicketingSystem();
        const commandRepository = new InMemoryTicketCommandRepository();
        const telemetry = new RecordingTelemetry();
        const command = createCommand(createCompleteRequestSpec());

        const execution = await executeCreateTicketCommand({ command, ticketingSystem, commandRepository, telemetry });
        const savedRecord = await commandRepository.get(command.id);

        expect(execution.result.ticketId).toBe("ticket_test_1");
        expect(savedRecord).toMatchObject({
            status: "succeeded",
            result: {
                ticketId: "ticket_test_1"
            }
        });
        expect(ticketingSystem.requests).toEqual([
            {
                idempotencyKey: command.idempotencyKey,
                conversationId: "conv_execute",
                requestedBy: "user_1",
                ticketSpec: command.ticketSpec
            }
        ]);
        expect(telemetry.events.map((event) => event.name)).toEqual(expect.arrayContaining([
            "ticket_command_execution_started",
            "ticketing_system_call_started",
            "ticketing_system_call_completed",
            "ticket_command_execution_completed"
        ]));
    });

    it("returns a stored result idempotently without calling the ticketing system again", async () => {
        const ticketingSystem = new RecordingTicketingSystem();
        const commandRepository = new InMemoryTicketCommandRepository();
        const command = createCommand(createCompleteRequestSpec());

        await executeCreateTicketCommand({ command, ticketingSystem, commandRepository });
        const replay = await executeCreateTicketCommand({ command, ticketingSystem, commandRepository });

        expect(replay).toMatchObject({
            commandId: command.id,
            idempotentReplay: true,
            result: {
                ticketId: "ticket_test_1"
            }
        });
        expect(ticketingSystem.requests).toHaveLength(1);
    });

    it("retries retryable ticketing system failures", async () => {
        const ticketingSystem = new TransientThenSuccessfulTicketingSystem(2);
        const commandRepository = new InMemoryTicketCommandRepository();
        const command = createCommand(createCompleteRequestSpec());

        const execution = await executeCreateTicketCommand({
            command,
            ticketingSystem,
            commandRepository,
            retry: {
                attempts: 3,
                baseDelayMs: 10,
                maxDelayMs: 100,
                sleep: async () => { }
            }
        });
        const savedRecord = await commandRepository.get(command.id);

        expect(execution.result.ticketId).toBe("ticket_retry_1");
        expect(ticketingSystem.requests).toHaveLength(3);
        expect(savedRecord?.attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed", "succeeded"]);
    });

    it("rejects create-ticket commands without human approval", async () => {
        const ticketingSystem = new RecordingTicketingSystem();
        const commandRepository = new InMemoryTicketCommandRepository();
        const command = createCommand(createCompleteRequestSpec());
        delete command.approval;

        await expect(executeCreateTicketCommand({ command, ticketingSystem, commandRepository })).rejects.toThrow("without human approval");

        expect(ticketingSystem.requests).toHaveLength(0);
        expect(await commandRepository.get(command.id)).toMatchObject({
            status: "rejected",
            rejectionReason: "missing_human_approval"
        });
    });

    it("rejects incomplete ticket commands before calling the ticketing system", async () => {
        const ticketingSystem = new RecordingTicketingSystem();
        const command = createCommand(createEmptyTicketSpec());

        await expect(executeCreateTicketCommand({ command, ticketingSystem })).rejects.toThrow("missing fields");
        expect(ticketingSystem.requests).toHaveLength(0);
    });

    it("redacts sensitive ticket specs and ticketing system results", async () => {
        const ticketingSystem = new SensitiveResultTicketingSystem();
        const commandRepository = new InMemoryTicketCommandRepository();
        const command = createCommand({
            ...createCompleteRequestSpec(),
            summary: "Reset VPN access with apiKey=super-secret-123",
            affectedUsers: ["admin@example.com"]
        });

        const execution = await executeCreateTicketCommand({ command, ticketingSystem, commandRepository });
        const savedRecord = await commandRepository.get(command.id);
        const serializedRecord = JSON.stringify(savedRecord);

        expect(ticketingSystem.requests[0]?.ticketSpec.summary).toContain("apiKey=[REDACTED:labeled_secret]");
        expect(ticketingSystem.requests[0]?.ticketSpec.affectedUsers).toEqual(["[REDACTED:email]"]);
        expect(execution.result.url).toContain("token=REDACTED_url_secret");
        expect(serializedRecord).not.toContain("super-secret-123");
        expect(serializedRecord).not.toContain("admin@example.com");
        expect(serializedRecord).not.toContain("secret-token-123");
    });
});

function createCommand(ticketSpec: TicketSpec): CreateTicketCommand {
    return {
        id: "create_ticket:conv_execute:test",
        type: "create_ticket",
        idempotencyKey: "create_ticket:conv_execute:test",
        conversationId: "conv_execute",
        requestedBy: "user_1",
        ticketSpec,
        riskLevel: "high",
        approvalRequired: true,
        approval: {
            status: "approved",
            approvedBy: "user_1",
            approvedAt: "2026-05-18T00:00:00.000Z",
            source: "explicit_user_confirmation"
        },
        plannedAt: "2026-05-18T00:00:00.000Z"
    };
}

function createCompleteRequestSpec(): TicketSpec {
    return {
        ...createEmptyTicketSpec(),
        ticketType: "request",
        summary: "Reset VPN access for contractors",
        affectedUsers: ["contractors"],
        affectedServices: ["vpn"],
        details: ["restore VPN access"],
        environment: "web"
    };
}