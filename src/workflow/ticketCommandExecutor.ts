import {
  createTicketRequestSchema,
  createTicketResultSchema,
  type TicketingSystemClient,
  type CreateTicketResult
} from "../ticketingSystem/ticketingSystemClient";
import { ticketSpecSchema } from "../domain/ticketSpec";
import { assessTicketSpecSafety, type ContentSafetyAssessment } from "../domain/contentSafety";
import { assessTicketSpecJailbreak, type JailbreakAssessment } from "../domain/jailbreakResistance";
import { getMissingFields } from "../domain/validation";
import { getErrorAttributes, noopTelemetry, type Telemetry } from "../observability/telemetry";
import type { TicketCommandRecord, CreateTicketCommand } from "./ticketCommand";
import {
  createPlannedTicketCommandRecord,
  markTicketCommandExecuting,
  markTicketCommandFailed,
  markTicketCommandRejected,
  markTicketCommandSucceeded
} from "./ticketCommand";
import type { TicketCommandRepository } from "../persistence/ticketCommandRepository";
import { redactSensitiveValue, type RedactionFinding } from "../privacy/redaction";
import { isRetryableServiceError, type RetryOptions, withRetry } from "../reliability/retry";

export type TicketingSystemRetryOptions = Partial<Pick<RetryOptions, "attempts" | "baseDelayMs" | "maxDelayMs" | "shouldRetry" | "sleep">>;

const defaultTicketingSystemRetryAttempts = 3;
const defaultTicketingSystemRetryBaseDelayMs = 250;
const defaultTicketingSystemRetryMaxDelayMs = 2000;

export interface ExecuteCreateTicketCommandInput {
  command: CreateTicketCommand;
  ticketingSystem: TicketingSystemClient;
  commandRepository?: TicketCommandRepository;
  retry?: TicketingSystemRetryOptions;
  telemetry?: Telemetry;
}

export interface ExecuteCreateTicketCommandResult {
  commandId: string;
  result: CreateTicketResult;
  latencyMs: number;
  idempotentReplay: boolean;
}

export async function executeCreateTicketCommand(input: ExecuteCreateTicketCommandInput): Promise<ExecuteCreateTicketCommandResult> {
  const telemetry = input.telemetry ?? noopTelemetry;
  const commandTicketSpecRedaction = redactSensitiveValue(input.command.ticketSpec);
  const command = commandTicketSpecRedaction.redacted
    ? { ...input.command, ticketSpec: commandTicketSpecRedaction.value }
    : input.command;
  emitRedactionTelemetry(telemetry, command, "ticket_command_ticket_spec", commandTicketSpecRedaction.findings);
  const approval = command.approval;
  let commandRecord = await getCommandRecord(command, input.commandRepository);

  if (commandRecord.status === "succeeded" && commandRecord.result) {
    telemetry.event("ticket_command_idempotent_result_returned", {
      commandId: command.id,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      conversationId: command.conversationId,
      ticketId: commandRecord.result.ticketId
    });
    telemetry.metric("ticket_command_idempotent_replay_count", 1, {
      conversationId: command.conversationId
    });
    return {
      commandId: command.id,
      result: commandRecord.result,
      latencyMs: 0,
      idempotentReplay: true
    };
  }

  if (!approval || approval.status !== "approved") {
    const error = new Error("Cannot execute ticket creation without human approval.");
    commandRecord = markTicketCommandRejected(commandRecord, "missing_human_approval", error);
    await input.commandRepository?.save(commandRecord);
    telemetry.event("ticket_command_execution_rejected", {
      commandId: command.id,
      commandType: command.type,
      conversationId: command.conversationId,
      riskLevel: command.riskLevel,
      reason: "missing_human_approval"
    });
    throw error;
  }

  const ticketSpecValidation = ticketSpecSchema.safeParse(command.ticketSpec);

  if (!ticketSpecValidation.success) {
    const error = new Error("Cannot execute ticket creation with an invalid ticket spec.");
    commandRecord = markTicketCommandRejected(commandRecord, "invalid_ticket_spec", error);
    await input.commandRepository?.save(commandRecord);
    telemetry.event("ticket_command_execution_rejected", {
      commandId: command.id,
      commandType: command.type,
      conversationId: command.conversationId,
      riskLevel: command.riskLevel,
      reason: "invalid_ticket_spec",
      ...getErrorAttributes(ticketSpecValidation.error)
    });
    throw error;
  }

  const validatedTicketSpec = ticketSpecValidation.data;
  const jailbreak = assessTicketSpecJailbreak(validatedTicketSpec);

  if (jailbreak.detected) {
    const error = new Error("Cannot execute ticket creation because the ticket spec violates jailbreak resistance policy.");
    commandRecord = markTicketCommandRejected(commandRecord, "jailbreak_resistance", error);
    await input.commandRepository?.save(commandRecord);
    telemetry.event("ticket_command_execution_rejected", {
      commandId: command.id,
      commandType: command.type,
      conversationId: command.conversationId,
      riskLevel: command.riskLevel,
      reason: "jailbreak_resistance",
      categories: jailbreak.categories
    });
    emitJailbreakTelemetry(telemetry, command, "ticket_command", jailbreak);
    throw error;
  }

  const contentSafety = assessTicketSpecSafety(validatedTicketSpec);

  if (!contentSafety.allowed) {
    const error = new Error("Cannot execute ticket creation because the ticket spec violates content safety policy.");
    commandRecord = markTicketCommandRejected(commandRecord, "content_safety", error);
    await input.commandRepository?.save(commandRecord);
    telemetry.event("ticket_command_execution_rejected", {
      commandId: command.id,
      commandType: command.type,
      conversationId: command.conversationId,
      riskLevel: command.riskLevel,
      reason: "content_safety",
      categories: contentSafety.categories
    });
    emitContentSafetyTelemetry(telemetry, command, "ticket_command", contentSafety);
    throw error;
  }

  const missingFields = getMissingFields(validatedTicketSpec);

  if (missingFields.length > 0) {
    const error = new Error(`Cannot execute ticket creation with missing fields: ${missingFields.join(", ")}`);
    commandRecord = markTicketCommandRejected(commandRecord, "missing_fields", error);
    await input.commandRepository?.save(commandRecord);
    telemetry.event("ticket_command_execution_rejected", {
      commandId: command.id,
      commandType: command.type,
      conversationId: command.conversationId,
      riskLevel: command.riskLevel,
      reason: "missing_fields",
      missingFields
    });
    throw error;
  }

  const lockAcquired = await input.commandRepository?.tryAcquireExecutionLock(command.id) ?? true;
  if (!lockAcquired) {
    telemetry.event("ticket_command_execution_rejected", {
      commandId: command.id,
      commandType: command.type,
      conversationId: command.conversationId,
      riskLevel: command.riskLevel,
      reason: "already_executing"
    });
    throw new Error("Cannot execute ticket creation because the command is already executing.");
  }

  try {
    commandRecord = await getCommandRecord(command, input.commandRepository);
    if (commandRecord.status === "succeeded" && commandRecord.result) {
      telemetry.event("ticket_command_idempotent_result_returned", {
        commandId: command.id,
        commandType: command.type,
        idempotencyKey: command.idempotencyKey,
        conversationId: command.conversationId,
        ticketId: commandRecord.result.ticketId
      });
      telemetry.metric("ticket_command_idempotent_replay_count", 1, {
        conversationId: command.conversationId
      });
      return {
        commandId: command.id,
        result: commandRecord.result,
        latencyMs: 0,
        idempotentReplay: true
      };
    }

    const executionStartedAt = Date.now();
    const result = await withRetry(async () => {
      const attemptStartedAt = Date.now();
      commandRecord = markTicketCommandExecuting(commandRecord);
      const attempt = commandRecord.attempts.at(-1);
      await input.commandRepository?.save(commandRecord);
      telemetry.event("ticket_command_execution_started", {
        commandId: command.id,
        commandType: command.type,
        idempotencyKey: command.idempotencyKey,
        conversationId: command.conversationId,
        userId: command.requestedBy,
        riskLevel: command.riskLevel,
        approvalSource: approval.source,
        approvedBy: approval.approvedBy,
        attemptNumber: attempt?.attemptNumber,
        ticketType: validatedTicketSpec.ticketType ?? null
      });
      telemetry.event("ticketing_system_call_started", {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        conversationId: command.conversationId,
        userId: command.requestedBy,
        attemptNumber: attempt?.attemptNumber,
        ticketType: validatedTicketSpec.ticketType ?? null
      });

      try {
        const ticketingSystemRequest = createTicketRequestSchema.parse({
          idempotencyKey: command.idempotencyKey,
          conversationId: command.conversationId,
          requestedBy: command.requestedBy,
          ticketSpec: validatedTicketSpec
        });
        const parsedTicketingSystemResult = createTicketResultSchema.parse(await input.ticketingSystem.createTicket(ticketingSystemRequest));
        const ticketingSystemResultRedaction = redactSensitiveValue(parsedTicketingSystemResult);
        emitRedactionTelemetry(telemetry, command, "ticketing_system_result", ticketingSystemResultRedaction.findings);
        const ticketingSystemResult = ticketingSystemResultRedaction.value;
        const attemptLatencyMs = Date.now() - attemptStartedAt;
        commandRecord = markTicketCommandSucceeded(commandRecord, ticketingSystemResult, attemptLatencyMs);
        await input.commandRepository?.save(commandRecord);

        telemetry.event("ticketing_system_call_completed", {
          commandId: command.id,
          idempotencyKey: command.idempotencyKey,
          conversationId: command.conversationId,
          userId: command.requestedBy,
          ticketId: ticketingSystemResult.ticketId,
          attemptNumber: attempt?.attemptNumber,
          latencyMs: attemptLatencyMs
        });

        return ticketingSystemResult;
      } catch (error) {
        const attemptLatencyMs = Date.now() - attemptStartedAt;
        commandRecord = markTicketCommandFailed(commandRecord, error, attemptLatencyMs);
        await input.commandRepository?.save(commandRecord);
        telemetry.event("ticketing_system_call_failed", {
          commandId: command.id,
          idempotencyKey: command.idempotencyKey,
          conversationId: command.conversationId,
          userId: command.requestedBy,
          attemptNumber: attempt?.attemptNumber,
          latencyMs: attemptLatencyMs,
          ...getErrorAttributes(error)
        });

        throw error;
      }
    }, getRetryOptions(input.retry, telemetry, command));

    const latencyMs = Date.now() - executionStartedAt;

    telemetry.metric("ticket_creation_success_count", 1, {
      conversationId: command.conversationId
    });
    telemetry.metric("ticketing_system_latency_ms", latencyMs, {
      conversationId: command.conversationId
    });
    telemetry.event("ticket_command_execution_completed", {
      commandId: command.id,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      conversationId: command.conversationId,
      ticketId: result.ticketId,
      latencyMs,
      attemptCount: commandRecord.attempts.length
    });

    return {
      commandId: command.id,
      result,
      latencyMs,
      idempotentReplay: false
    };
  } catch (error) {
    telemetry.metric("ticket_creation_failure_count", 1, {
      conversationId: command.conversationId
    });
    telemetry.event("ticket_command_execution_failed", {
      commandId: command.id,
      commandType: command.type,
      idempotencyKey: command.idempotencyKey,
      conversationId: command.conversationId,
      attemptCount: commandRecord.attempts.length,
      ...getErrorAttributes(error)
    });
    throw error;
  } finally {
    await input.commandRepository?.releaseExecutionLock(command.id);
  }
}

async function getCommandRecord(command: CreateTicketCommand, repository: TicketCommandRepository | undefined): Promise<TicketCommandRecord> {
  const savedRecord = await repository?.get(command.id);
  return savedRecord ? redactSensitiveValue(savedRecord).value : createPlannedTicketCommandRecord(command);
}

function emitRedactionTelemetry(
  telemetry: Telemetry,
  command: CreateTicketCommand,
  boundary: string,
  findings: RedactionFinding[]
): void {
  if (findings.length === 0) {
    return;
  }

  const redactionCount = findings.reduce((total, finding) => total + finding.count, 0);
  telemetry.event("sensitive_data_redacted", {
    commandId: command.id,
    commandType: command.type,
    conversationId: command.conversationId,
    userId: command.requestedBy,
    boundary,
    findingTypes: findings.map((finding) => finding.type)
  });
  telemetry.metric("sensitive_data_redaction_count", redactionCount, {
    conversationId: command.conversationId,
    boundary
  });
}

function emitContentSafetyTelemetry(
  telemetry: Telemetry,
  command: CreateTicketCommand,
  boundary: string,
  assessment: ContentSafetyAssessment
): void {
  telemetry.event("content_safety_blocked", {
    commandId: command.id,
    commandType: command.type,
    conversationId: command.conversationId,
    userId: command.requestedBy,
    boundary,
    categories: assessment.categories,
    reason: assessment.reason
  });
  telemetry.metric("content_safety_block_count", 1, {
    conversationId: command.conversationId,
    boundary,
    categories: assessment.categories
  });
}

function emitJailbreakTelemetry(
  telemetry: Telemetry,
  command: CreateTicketCommand,
  boundary: string,
  assessment: Pick<JailbreakAssessment, "categories" | "reason" | "action">
): void {
  const outcome = assessment.action === "block" ? "blocked" : "sanitized";
  telemetry.event("jailbreak_attempt_detected", {
    commandId: command.id,
    commandType: command.type,
    conversationId: command.conversationId,
    userId: command.requestedBy,
    boundary,
    outcome,
    categories: assessment.categories,
    reason: assessment.reason
  });
  telemetry.metric("jailbreak_attempt_count", 1, {
    conversationId: command.conversationId,
    boundary,
    outcome,
    categories: assessment.categories
  });
}

function getRetryOptions(
  retry: TicketingSystemRetryOptions | undefined,
  telemetry: Telemetry,
  command: CreateTicketCommand
): RetryOptions {
  return {
    attempts: retry?.attempts ?? defaultTicketingSystemRetryAttempts,
    baseDelayMs: retry?.baseDelayMs ?? defaultTicketingSystemRetryBaseDelayMs,
    maxDelayMs: retry?.maxDelayMs ?? defaultTicketingSystemRetryMaxDelayMs,
    shouldRetry: retry?.shouldRetry ?? isRetryableServiceError,
    sleep: retry?.sleep,
    onRetry(error, attempt, delayMs) {
      telemetry.event("ticketing_system_retry_scheduled", {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        conversationId: command.conversationId,
        attemptNumber: attempt,
        nextAttemptNumber: attempt + 1,
        delayMs,
        ...getErrorAttributes(error)
      });
      telemetry.metric("ticketing_system_retry_scheduled_count", 1, {
        conversationId: command.conversationId
      });
    }
  };
}
