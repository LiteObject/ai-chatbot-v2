import type { TicketSpec } from "../domain/ticketSpec";
import { assessTicketSpecSafety } from "../domain/contentSafety";
import { assessTicketSpecJailbreak } from "../domain/jailbreakResistance";
import type { ConversationState } from "../domain/conversationState";
import { getMissingFields } from "../domain/validation";
import type { CreateTicketResult } from "../ticketingSystem/ticketingSystemClient";
import { redactSensitiveText } from "../privacy/redaction";
import { createHash } from "node:crypto";

export type TicketCommandRiskLevel = "high";
export type HumanApprovalSource = "explicit_user_confirmation";

export interface HumanApproval {
  status: "approved";
  approvedBy: string | null;
  approvedAt: string;
  source: HumanApprovalSource;
}

export interface CreateTicketCommand {
  id: string;
  type: "create_ticket";
  idempotencyKey: string;
  conversationId: string;
  requestedBy: string | null;
  ticketSpec: TicketSpec;
  riskLevel: TicketCommandRiskLevel;
  approvalRequired: true;
  approval?: HumanApproval;
  plannedAt: string;
}

export type TicketCommand = CreateTicketCommand;

export type TicketCommandStatus = "planned" | "executing" | "succeeded" | "failed" | "rejected";
export type TicketCommandAttemptStatus = "executing" | "succeeded" | "failed" | "rejected";

export interface TicketCommandError {
  errorName: string;
  errorMessage: string;
}

export interface TicketCommandExecutionAttempt {
  attemptNumber: number;
  status: TicketCommandAttemptStatus;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  error?: TicketCommandError;
}

export interface TicketCommandToolOutput {
  toolName: "ticketing_system";
  status: "succeeded" | "failed" | "rejected";
  recordedAt: string;
  latencyMs?: number;
  output?: CreateTicketResult;
  error?: TicketCommandError;
  rejectionReason?: string;
}

export interface TicketCommandRecord {
  command: TicketCommand;
  status: TicketCommandStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  attempts: TicketCommandExecutionAttempt[];
  toolOutputs: TicketCommandToolOutput[];
  result?: CreateTicketResult;
  error?: TicketCommandError;
  rejectionReason?: string;
}

export function planCreateTicketCommand(state: ConversationState): CreateTicketCommand {
  if (state.status !== "creating_ticket") {
    throw new Error(`Cannot plan ticket creation while conversation status is ${state.status}.`);
  }

  if (!state.confirmed) {
    throw new Error("Cannot plan ticket creation before explicit confirmation.");
  }

  if (!state.readyToBuild) {
    throw new Error("Cannot plan ticket creation before requirements are ready.");
  }

  const missingFields = getMissingFields(state.ticketSpec);
  if (missingFields.length > 0) {
    throw new Error(`Cannot plan ticket creation with missing fields: ${missingFields.join(", ")}`);
  }

  const jailbreak = assessTicketSpecJailbreak(state.ticketSpec);
  if (jailbreak.detected) {
    throw new Error("Cannot plan ticket creation because the ticket spec violates jailbreak resistance policy.");
  }

  const contentSafety = assessTicketSpecSafety(state.ticketSpec);
  if (!contentSafety.allowed) {
    throw new Error("Cannot plan ticket creation because the ticket spec violates content safety policy.");
  }

  const plannedAt = new Date().toISOString();

  const commandId = buildCreateTicketCommandId(state.conversationId, state.ticketSpec);

  return {
    id: commandId,
    type: "create_ticket",
    idempotencyKey: commandId,
    conversationId: state.conversationId,
    requestedBy: state.userId ?? null,
    ticketSpec: structuredClone(state.ticketSpec),
    riskLevel: "high",
    approvalRequired: true,
    approval: {
      status: "approved",
      approvedBy: state.userId ?? null,
      approvedAt: plannedAt,
      source: "explicit_user_confirmation"
    },
    plannedAt
  };
}

function buildCreateTicketCommandId(conversationId: string, ticketSpec: TicketSpec): string {
  return `create_ticket:${conversationId}:${getTicketSpecFingerprint(ticketSpec)}`;
}

function getTicketSpecFingerprint(ticketSpec: TicketSpec): string {
  return createHash("sha256").update(JSON.stringify(ticketSpec)).digest("hex").slice(0, 16);
}

export function createPlannedTicketCommandRecord(command: TicketCommand): TicketCommandRecord {
  return {
    command: structuredClone(command),
    status: "planned",
    createdAt: command.plannedAt,
    updatedAt: command.plannedAt,
    attempts: [],
    toolOutputs: []
  };
}

export function markTicketCommandExecuting(record: TicketCommandRecord, startedAt = new Date().toISOString()): TicketCommandRecord {
  const next = structuredClone(record);
  const attemptNumber = next.attempts.length + 1;

  next.status = "executing";
  next.updatedAt = startedAt;
  delete next.completedAt;
  delete next.result;
  delete next.error;
  delete next.rejectionReason;
  next.attempts.push({
    attemptNumber,
    status: "executing",
    startedAt
  });

  return next;
}

export function markTicketCommandSucceeded(
  record: TicketCommandRecord,
  result: CreateTicketResult,
  latencyMs: number,
  completedAt = new Date().toISOString()
): TicketCommandRecord {
  const next = structuredClone(record);
  const currentAttempt = next.attempts.at(-1);

  next.status = "succeeded";
  next.updatedAt = completedAt;
  next.completedAt = completedAt;
  next.result = structuredClone(result);
  delete next.error;
  delete next.rejectionReason;

  if (currentAttempt) {
    currentAttempt.status = "succeeded";
    currentAttempt.completedAt = completedAt;
    currentAttempt.latencyMs = latencyMs;
  }

  next.toolOutputs.push({
    toolName: "ticketing_system",
    status: "succeeded",
    recordedAt: completedAt,
    latencyMs,
    output: structuredClone(result)
  });

  return next;
}

export function markTicketCommandFailed(
  record: TicketCommandRecord,
  error: unknown,
  latencyMs: number,
  completedAt = new Date().toISOString()
): TicketCommandRecord {
  const next = structuredClone(record);
  const commandError = getTicketCommandError(error);
  const currentAttempt = next.attempts.at(-1);

  next.status = "failed";
  next.updatedAt = completedAt;
  next.completedAt = completedAt;
  next.error = commandError;
  delete next.result;
  delete next.rejectionReason;

  if (currentAttempt) {
    currentAttempt.status = "failed";
    currentAttempt.completedAt = completedAt;
    currentAttempt.latencyMs = latencyMs;
    currentAttempt.error = commandError;
  }

  next.toolOutputs.push({
    toolName: "ticketing_system",
    status: "failed",
    recordedAt: completedAt,
    latencyMs,
    error: commandError
  });

  return next;
}

export function markTicketCommandRejected(
  record: TicketCommandRecord,
  rejectionReason: string,
  error: unknown,
  rejectedAt = new Date().toISOString()
): TicketCommandRecord {
  const next = structuredClone(record);
  const commandError = getTicketCommandError(error);

  next.status = "rejected";
  next.updatedAt = rejectedAt;
  next.completedAt = rejectedAt;
  next.error = commandError;
  next.rejectionReason = rejectionReason;
  delete next.result;

  next.attempts.push({
    attemptNumber: next.attempts.length + 1,
    status: "rejected",
    startedAt: rejectedAt,
    completedAt: rejectedAt,
    error: commandError
  });
  next.toolOutputs.push({
    toolName: "ticketing_system",
    status: "rejected",
    recordedAt: rejectedAt,
    error: commandError,
    rejectionReason
  });

  return next;
}

function getTicketCommandError(error: unknown): TicketCommandError {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: redactSensitiveText(error.message).value
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: redactSensitiveText(String(error)).value
  };
}
