import type { TicketingSystemClient } from "../ticketingSystem/ticketingSystemClient";
import {
  normalizeTicketEnvironment,
  partialTicketSpecSchema,
  type TicketSpec,
  type TicketSpecField,
  type PartialTicketSpec
} from "../domain/ticketSpec";
import { classifyConfirmationDeterministically } from "../domain/confirmation";
import {
  assessTicketSpecSafety,
  assessContentSafetyText,
  getContentSafetyAssistantFallback,
  getContentSafetyBlockedMessage,
  type ContentSafetyAssessment
} from "../domain/contentSafety";
import {
  assessTicketSpecJailbreak,
  assessJailbreakText,
  assessPartialTicketSpecJailbreak,
  getJailbreakAssistantFallback,
  getJailbreakBlockedMessage,
  type JailbreakAssessment
} from "../domain/jailbreakResistance";
import {
  appendMessage,
  type ChatMessage,
  createConversationState,
  type ConversationState,
  type ConversationStatus
} from "../domain/conversationState";
import {
  compactConversationForContext,
  defaultContextWindowOptions,
  getContextWindowUsage,
  type ContextWindowOptions,
  type ContextWindowUsage
} from "../domain/contextWindow";
import { mergeTicketSpec } from "../domain/mergeTicketSpec";
import { createUserPreferences, mergeUserPreferencesFromTicketSpec, type UserPreferences } from "../domain/userPreferences";
import { getMissingFields, getRequiredFieldsForSpec } from "../domain/validation";
import type { LlmClient } from "../llm/llmClient";
import { getErrorAttributes, noopTelemetry, type Telemetry } from "../observability/telemetry";
import type { TicketCommandRepository } from "../persistence/ticketCommandRepository";
import type { ConversationRepository } from "../persistence/conversationRepository";
import type { UserPreferencesRepository } from "../persistence/userPreferencesRepository";
import { redactSensitiveText, redactSensitiveValue, type RedactionFinding } from "../privacy/redaction";
import { createPlannedTicketCommandRecord, planCreateTicketCommand, type TicketCommandRecord } from "./ticketCommand";
import { executeCreateTicketCommand, type TicketingSystemRetryOptions } from "./ticketCommandExecutor";

export interface HandleChatTurnInput {
  conversationId: string;
  userId?: string | null;
  message: string;
  repository: ConversationRepository;
  userPreferencesRepository?: UserPreferencesRepository;
  commandRepository?: TicketCommandRepository;
  llmClient: LlmClient;
  ticketingSystem: TicketingSystemClient;
  contextWindow?: ContextWindowOptions;
  ticketingSystemRetry?: TicketingSystemRetryOptions;
  telemetry?: Telemetry;
}

export interface ChatTurnResponse {
  conversationId: string;
  status: ConversationStatus;
  message: string;
  messages: ChatMessage[];
  ticketSpec: TicketSpec;
  missingFields: string[];
  requiredFields: TicketSpecField[];
  contextWindow: ContextWindowUsage;
  createdTicket?: {
    ticketId: string;
    url: string;
  };
  userPreferences?: UserPreferences;
  commands?: TicketCommandRecord[];
}

export async function handleChatTurn(input: HandleChatTurnInput): Promise<ChatTurnResponse> {
  const telemetry = input.telemetry ?? noopTelemetry;
  const startedAt = Date.now();

  try {
    return await handleChatTurnInternal(input, telemetry, startedAt);
  } catch (error) {
    telemetry.event("chat_turn_failed", {
      conversationId: input.conversationId,
      userId: input.userId ?? null,
      ...getErrorAttributes(error)
    });
    telemetry.metric("chat_turn_failure_count", 1, {
      conversationId: input.conversationId
    });
    throw error;
  }
}

async function handleChatTurnInternal(
  input: HandleChatTurnInput,
  telemetry: Telemetry,
  startedAt: number
): Promise<ChatTurnResponse> {
  const messageRedaction = redactSensitiveText(input.message);
  const safeInput = messageRedaction.redacted ? { ...input, message: messageRedaction.value } : input;
  const existingState = await safeInput.repository.get(safeInput.conversationId);
  const state = existingState ?? createConversationState(safeInput.conversationId, safeInput.userId);
  const contextWindow = safeInput.contextWindow ?? defaultContextWindowOptions;
  state.userId = safeInput.userId ?? state.userId ?? null;
  emitRedactionTelemetry(telemetry, state.conversationId, state.userId, "user_message", messageRedaction.findings);
  telemetry.event("chat_turn_started", {
    conversationId: state.conversationId,
    userId: state.userId ?? null,
    status: state.status,
    newConversation: existingState === undefined
  });
  if (existingState === undefined) {
    telemetry.metric("conversation_started_count", 1, {
      conversationId: state.conversationId
    });
  }

  const userMessageJailbreak = assessJailbreakText(safeInput.message);
  if (userMessageJailbreak.detected) {
    emitJailbreakTelemetry(telemetry, state.conversationId, state.userId, "user_message", userMessageJailbreak);
  }
  if (!userMessageJailbreak.allowed) {
    return blockJailbreakTurn(safeInput, state, contextWindow, telemetry, startedAt, true);
  }

  const guardedInput = userMessageJailbreak.action === "sanitize"
    ? { ...safeInput, message: userMessageJailbreak.sanitizedText }
    : safeInput;

  const userMessageSafety = assessContentSafetyText(guardedInput.message);
  if (!userMessageSafety.allowed) {
    return blockUnsafeTurn(guardedInput, state, contextWindow, telemetry, startedAt, "user_message", userMessageSafety, true);
  }

  appendMessage(state, "user", guardedInput.message);
  compactConversationForContext(state, contextWindow);

  if (state.status === "awaiting_confirmation") {
    return handleConfirmationTurn(state, guardedInput, contextWindow, telemetry, startedAt);
  }

  if (state.status === "created") {
    return saveAndRespond(guardedInput, state, getCreatedConversationResponse(guardedInput.message, state), contextWindow, telemetry, startedAt);
  }

  return handleRequirementCollectionTurn(state, guardedInput, contextWindow, telemetry, startedAt);
}

async function handleRequirementCollectionTurn(
  state: ConversationState,
  input: HandleChatTurnInput,
  contextWindow: ContextWindowOptions,
  telemetry: Telemetry,
  startedAt: number
): Promise<ChatTurnResponse> {
  if (getContextWindowUsage(state, contextWindow).status === "blocked") {
    telemetry.event("context_window_blocked", {
      conversationId: state.conversationId,
      userId: state.userId ?? null
    });
    return saveAndRespond(input, state, getContextLimitMessage(), contextWindow, telemetry, startedAt);
  }

  const deterministicCasualResponse = getDeterministicCasualResponse(input.message);
  if (deterministicCasualResponse) {
    state.readyToBuild = false;
    state.confirmed = false;
    state.status = "collecting_requirements";
    state.missingFields = getMissingFields(state.ticketSpec);
    return saveAndRespond(input, state, deterministicCasualResponse, contextWindow, telemetry, startedAt);
  }

  const extracted = await extractRequirements(state, input, telemetry);

  const casualResponse = countExtractedFields(extracted) === 0 ? getCasualResponse(input.message) : undefined;
  if (casualResponse) {
    state.readyToBuild = false;
    state.confirmed = false;
    state.status = "collecting_requirements";
    state.missingFields = getMissingFields(state.ticketSpec);
    return saveAndRespond(input, state, casualResponse, contextWindow, telemetry, startedAt);
  }

  return applyRequirementsAndRespond(state, input, contextWindow, telemetry, startedAt, extracted);
}

async function applyRequirementsAndRespond(
  state: ConversationState,
  input: HandleChatTurnInput,
  contextWindow: ContextWindowOptions,
  telemetry: Telemetry,
  startedAt: number,
  extracted: Partial<TicketSpec>
): Promise<ChatTurnResponse> {
  const mergedSpec = mergeTicketSpec(state.ticketSpec, extracted);
  const ticketSpecJailbreak = assessTicketSpecJailbreak(mergedSpec);
  if (ticketSpecJailbreak.detected) {
    emitJailbreakTelemetry(telemetry, state.conversationId, state.userId, "ticket_spec", ticketSpecJailbreak);
  }
  if (!ticketSpecJailbreak.allowed) {
    state.ticketSpec = ticketSpecJailbreak.sanitizedTicketSpec;
    return blockJailbreakTurn(input, state, contextWindow, telemetry, startedAt);
  }

  const candidateSpec = ticketSpecJailbreak.sanitizedTicketSpec;
  const ticketSpecSafety = assessTicketSpecSafety(candidateSpec);
  if (!ticketSpecSafety.allowed) {
    return blockUnsafeTurn(input, state, contextWindow, telemetry, startedAt, "ticket_spec", ticketSpecSafety);
  }

  state.ticketSpec = candidateSpec;
  state.missingFields = getMissingFields(state.ticketSpec);
  telemetry.event("missing_fields_evaluated", {
    conversationId: state.conversationId,
    userId: state.userId ?? null,
    missingFields: state.missingFields,
    missingFieldCount: state.missingFields.length
  });

  if (state.missingFields.length > 0) {
    state.readyToBuild = false;
    state.confirmed = false;
    state.status = "collecting_requirements";

    const response = await input.llmClient.generateClarifyingQuestion({
      ticketSpec: state.ticketSpec,
      missingFields: state.missingFields
    });

    telemetry.metric("clarification_question_count", 1, {
      conversationId: state.conversationId
    });

    return saveAndRespond(input, state, response, contextWindow, telemetry, startedAt);
  }

  state.readyToBuild = true;
  state.confirmed = false;
  state.status = "awaiting_confirmation";

  const response = await input.llmClient.generateConfirmationSummary({ ticketSpec: state.ticketSpec });
  telemetry.event("confirmation_requested", {
    conversationId: state.conversationId,
    userId: state.userId ?? null,
    ticketType: state.ticketSpec.ticketType ?? null
  });
  return saveAndRespond(input, state, response, contextWindow, telemetry, startedAt);
}

async function handleConfirmationTurn(
  state: ConversationState,
  input: HandleChatTurnInput,
  contextWindow: ContextWindowOptions,
  telemetry: Telemetry,
  startedAt: number
): Promise<ChatTurnResponse> {
  const deterministicDecision = classifyConfirmationDeterministically(input.message);
  const decision = deterministicDecision;

  if (deterministicDecision === "ambiguous") {
    const requirementChangeResponse = await tryHandleConfirmationRequirementChange(
      state,
      input,
      contextWindow,
      telemetry,
      startedAt
    );
    if (requirementChangeResponse) {
      return requirementChangeResponse;
    }
  }

  telemetry.event("confirmation_received", {
    conversationId: state.conversationId,
    userId: state.userId ?? null,
    decision
  });
  telemetry.metric("confirmation_decision_count", 1, {
    conversationId: state.conversationId,
    decision
  });

  if (decision === "no") {
    state.confirmed = false;
    state.readyToBuild = false;
    state.status = "collecting_requirements";
    return saveAndRespond(input, state, "No problem. What would you like to change?", contextWindow, telemetry, startedAt);
  }

  if (decision === "ambiguous") {
    return saveAndRespond(input, state, "Please reply yes to create the ticket, or no if you want to change the requirements.", contextWindow, telemetry, startedAt);
  }

  state.confirmed = true;
  state.readyToBuild = true;
  state.status = "creating_ticket";
  state.missingFields = getMissingFields(state.ticketSpec);

  const ticketSpecJailbreak = assessTicketSpecJailbreak(state.ticketSpec);
  if (ticketSpecJailbreak.detected) {
    emitJailbreakTelemetry(telemetry, state.conversationId, state.userId, "ticket_spec", ticketSpecJailbreak);
    state.ticketSpec = ticketSpecJailbreak.sanitizedTicketSpec;
    state.missingFields = getMissingFields(state.ticketSpec);
  }
  if (!ticketSpecJailbreak.allowed) {
    state.confirmed = false;
    state.readyToBuild = false;
    return blockJailbreakTurn(input, state, contextWindow, telemetry, startedAt);
  }

  if (state.missingFields.length > 0) {
    state.confirmed = false;
    state.readyToBuild = false;
    state.status = "collecting_requirements";
    const response = await input.llmClient.generateClarifyingQuestion({
      ticketSpec: state.ticketSpec,
      missingFields: state.missingFields
    });
    return saveAndRespond(input, state, response, contextWindow, telemetry, startedAt);
  }

  const ticketSpecSafety = assessTicketSpecSafety(state.ticketSpec);
  if (!ticketSpecSafety.allowed) {
    state.confirmed = false;
    state.readyToBuild = false;
    return blockUnsafeTurn(input, state, contextWindow, telemetry, startedAt, "ticket_spec", ticketSpecSafety);
  }

  const command = planCreateTicketCommand(state);
  await input.commandRepository?.save(createPlannedTicketCommandRecord(command));
  telemetry.event("ticket_command_planned", {
    commandId: command.id,
    commandType: command.type,
    conversationId: state.conversationId,
    userId: state.userId ?? null,
    riskLevel: command.riskLevel,
    approvalRequired: command.approvalRequired,
    approvalSource: command.approval?.source,
    ticketType: state.ticketSpec.ticketType ?? null
  });

  try {
    const execution = await executeCreateTicketCommand({
      command,
      ticketingSystem: input.ticketingSystem,
      commandRepository: input.commandRepository,
      retry: input.ticketingSystemRetry,
      telemetry
    });
    const result = execution.result;
    state.status = "created";
    state.createdTicketId = result.ticketId;
    state.createdTicketUrl = result.url;
    return saveAndRespond(input, state, `Created the ticket. You can open it at ${result.url}.`, contextWindow, telemetry, startedAt, {
      ticketId: result.ticketId,
      url: result.url
    });
  } catch (error) {
    state.status = "failed";
    telemetry.event("ticket_command_failed_to_complete", {
      commandId: command.id,
      commandType: command.type,
      conversationId: state.conversationId,
      userId: state.userId ?? null,
      ...getErrorAttributes(error)
    });
    return saveAndRespond(input, state, "I could not create the ticket because the ticketing system failed. Your requirements are saved, so you can try again in a moment.", contextWindow, telemetry, startedAt);
  }
}

async function tryHandleConfirmationRequirementChange(
  state: ConversationState,
  input: HandleChatTurnInput,
  contextWindow: ContextWindowOptions,
  telemetry: Telemetry,
  startedAt: number
): Promise<ChatTurnResponse | undefined> {
  if (getContextWindowUsage(state, contextWindow).status === "blocked") {
    return undefined;
  }

  const extracted = await extractRequirements(state, input, telemetry);
  if (countExtractedFields(extracted) === 0) {
    return undefined;
  }

  state.confirmed = false;
  state.readyToBuild = false;
  telemetry.event("confirmation_requirement_change_detected", {
    conversationId: state.conversationId,
    userId: state.userId ?? null,
    extractedFieldCount: countExtractedFields(extracted)
  });

  return applyRequirementsAndRespond(state, input, contextWindow, telemetry, startedAt, extracted);
}

async function extractRequirements(
  state: ConversationState,
  input: HandleChatTurnInput,
  telemetry: Telemetry
): Promise<Partial<TicketSpec>> {
  telemetry.event("requirement_extraction_started", {
    conversationId: state.conversationId,
    userId: state.userId ?? null,
    missingFields: state.missingFields
  });

  let rawExtracted: unknown;
  try {
    rawExtracted = await input.llmClient.extractTicketSpec({
      userMessage: input.message,
      currentSpec: state.ticketSpec,
      missingFields: state.missingFields
    });
  } catch (error) {
    telemetry.event("requirement_extraction_failed", {
      conversationId: state.conversationId,
      userId: state.userId ?? null,
      ...getErrorAttributes(error)
    });
    telemetry.metric("llm_request_failure_count", 1, {
      conversationId: state.conversationId,
      task: "extract_ticket_spec"
    });
    throw error;
  }

  const extracted = addDeterministicExtraction(
    input.message,
    validateExtractedRequirements(rawExtracted, state, telemetry)
  );

  telemetry.event("requirement_extraction_completed", {
    conversationId: state.conversationId,
    userId: state.userId ?? null,
    extractedFieldCount: countExtractedFields(extracted)
  });

  return extracted;
}

function validateExtractedRequirements(
  rawExtracted: unknown,
  state: ConversationState,
  telemetry: Telemetry
): PartialTicketSpec {
  const parsed = partialTicketSpecSchema.safeParse(rawExtracted);

  if (parsed.success) {
    const redacted = redactSensitiveValue(parsed.data);
    emitRedactionTelemetry(telemetry, state.conversationId, state.userId, "llm_extraction", redacted.findings);
    const jailbreak = assessPartialTicketSpecJailbreak(redacted.value);
    if (jailbreak.detected) {
      emitJailbreakTelemetry(telemetry, state.conversationId, state.userId, "llm_extraction", jailbreak);
    }
    return jailbreak.sanitizedTicketSpec;
  }

  telemetry.event("llm_extracted_requirements_rejected", {
    conversationId: state.conversationId,
    userId: state.userId ?? null,
    ...getErrorAttributes(parsed.error)
  });
  telemetry.metric("llm_extracted_requirements_rejected_count", 1, {
    conversationId: state.conversationId
  });

  return {};
}

async function saveAndRespond(
  input: HandleChatTurnInput,
  state: ConversationState,
  message: string,
  contextWindow: ContextWindowOptions,
  telemetry: Telemetry,
  startedAt: number,
  createdTicket?: ChatTurnResponse["createdTicket"]
): Promise<ChatTurnResponse> {
  const messageRedaction = redactSensitiveText(message);
  const assistantSafety = assessContentSafetyText(messageRedaction.value);
  let safeMessage = assistantSafety.allowed ? messageRedaction.value : getContentSafetyAssistantFallback();
  emitRedactionTelemetry(telemetry, state.conversationId, state.userId, "assistant_message", messageRedaction.findings);
  if (!assistantSafety.allowed) {
    emitContentSafetyTelemetry(telemetry, state.conversationId, state.userId, "assistant_message", assistantSafety);
  }
  const assistantJailbreak = assessJailbreakText(safeMessage);
  if (assistantJailbreak.detected) {
    emitJailbreakTelemetry(telemetry, state.conversationId, state.userId, "assistant_message", assistantJailbreak);
    safeMessage = getJailbreakAssistantFallback();
  }
  appendMessage(state, "assistant", safeMessage);
  compactConversationForContext(state, contextWindow);
  const userPreferences = await saveUserPreferences(input.userPreferencesRepository, state);
  await input.repository.save(state);
  const latencyMs = Date.now() - startedAt;
  telemetry.event("chat_turn_completed", {
    conversationId: state.conversationId,
    userId: state.userId ?? null,
    status: state.status,
    latencyMs
  });
  telemetry.metric("chat_turn_latency_ms", latencyMs, {
    conversationId: state.conversationId,
    status: state.status
  });

  const commands = await input.commandRepository?.listByConversationId(state.conversationId);

  return {
    conversationId: state.conversationId,
    status: state.status,
    message: safeMessage,
    messages: state.messages,
    ticketSpec: state.ticketSpec,
    missingFields: state.missingFields,
    requiredFields: getRequiredFieldsForSpec(state.ticketSpec),
    contextWindow: getContextWindowUsage(state, contextWindow),
    createdTicket,
    userPreferences,
    commands
  };
}

async function blockUnsafeTurn(
  input: HandleChatTurnInput,
  state: ConversationState,
  contextWindow: ContextWindowOptions,
  telemetry: Telemetry,
  startedAt: number,
  boundary: string,
  assessment: ContentSafetyAssessment,
  appendUserPlaceholder = false
): Promise<ChatTurnResponse> {
  state.confirmed = false;
  state.readyToBuild = false;
  state.status = "blocked";
  state.missingFields = getMissingFields(state.ticketSpec);
  if (appendUserPlaceholder) {
    appendMessage(state, "user", "[Blocked user request omitted by content safety]");
  }
  emitContentSafetyTelemetry(telemetry, state.conversationId, state.userId, boundary, assessment);
  return saveAndRespond(input, state, getContentSafetyBlockedMessage(), contextWindow, telemetry, startedAt);
}

async function blockJailbreakTurn(
  input: HandleChatTurnInput,
  state: ConversationState,
  contextWindow: ContextWindowOptions,
  telemetry: Telemetry,
  startedAt: number,
  appendUserPlaceholder = false
): Promise<ChatTurnResponse> {
  state.confirmed = false;
  state.readyToBuild = false;
  state.status = "blocked";
  state.missingFields = getMissingFields(state.ticketSpec);
  if (appendUserPlaceholder) {
    appendMessage(state, "user", "[Blocked user request omitted by jailbreak resistance]");
  }
  return saveAndRespond(input, state, getJailbreakBlockedMessage(), contextWindow, telemetry, startedAt);
}

function emitContentSafetyTelemetry(
  telemetry: Telemetry,
  conversationId: string,
  userId: string | null | undefined,
  boundary: string,
  assessment: ContentSafetyAssessment
): void {
  telemetry.event("content_safety_blocked", {
    conversationId,
    userId: userId ?? null,
    boundary,
    categories: assessment.categories,
    reason: assessment.reason
  });
  telemetry.metric("content_safety_block_count", 1, {
    conversationId,
    boundary,
    categories: assessment.categories
  });
}

function emitJailbreakTelemetry(
  telemetry: Telemetry,
  conversationId: string,
  userId: string | null | undefined,
  boundary: string,
  assessment: Pick<JailbreakAssessment, "categories" | "reason" | "action">
): void {
  const outcome = assessment.action === "block" ? "blocked" : "sanitized";
  telemetry.event("jailbreak_attempt_detected", {
    conversationId,
    userId: userId ?? null,
    boundary,
    outcome,
    categories: assessment.categories,
    reason: assessment.reason
  });
  telemetry.metric("jailbreak_attempt_count", 1, {
    conversationId,
    boundary,
    outcome,
    categories: assessment.categories
  });
}

function emitRedactionTelemetry(
  telemetry: Telemetry,
  conversationId: string,
  userId: string | null | undefined,
  boundary: string,
  findings: RedactionFinding[]
): void {
  if (findings.length === 0) {
    return;
  }

  const redactionCount = findings.reduce((total, finding) => total + finding.count, 0);
  telemetry.event("sensitive_data_redacted", {
    conversationId,
    userId: userId ?? null,
    boundary,
    findingTypes: findings.map((finding) => finding.type)
  });
  telemetry.metric("sensitive_data_redaction_count", redactionCount, {
    conversationId,
    boundary
  });
}

async function saveUserPreferences(
  repository: UserPreferencesRepository | undefined,
  state: ConversationState
): Promise<UserPreferences | undefined> {
  if (!repository || !state.userId) {
    return undefined;
  }

  const existingPreferences = await repository.get(state.userId) ?? createUserPreferences(state.userId);
  const nextPreferences = mergeUserPreferencesFromTicketSpec(existingPreferences, state.ticketSpec);
  await repository.save(nextPreferences);
  return nextPreferences;
}

function getContextLimitMessage(): string {
  return "This conversation has reached the configured context limit, so I paused new requirement extraction to avoid dropping context. Your current ticket spec is saved; start a new conversation or increase the context window setting before continuing.";
}

function addDeterministicExtraction(message: string, extracted: PartialTicketSpec): PartialTicketSpec {
  const environment = normalizeTicketEnvironment(message);
  const ticketType = getDeterministicTicketType(message);
  const next = { ...extracted };

  if (ticketType && !hasValue(next.ticketType)) {
    next.ticketType = ticketType;
  }

  if (environment && !hasValue(next.environment)) {
    next.environment = environment;
  }

  return next;
}

function getDeterministicTicketType(message: string): TicketSpec["ticketType"] | undefined {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (/\b(incident|bug|defect|error|broken|outage|down|failing|failure|cannot|can't|unable)\b/.test(normalized)) {
    return "incident";
  }

  if (/\b(request|service request|feature request|access request|password reset|unlock|provision|install|need access|need a|need an|would like)\b/.test(normalized)) {
    return "request";
  }

  return undefined;
}

function getCasualResponse(message: string): string | undefined {
  const normalized = message.trim().toLowerCase();

  if (/^(thanks|thank you|thx)\b/.test(normalized)) {
    return "You're welcome. Tell me what you want to adjust next, or start a new conversation when you're ready for another ticket.";
  }

  if (/\bhow are you\b/.test(normalized)) {
    return "I'm doing well and ready to help with a support ticket. Tell me whether this is a request or an incident and what is happening.";
  }

  if (/\bwhat(?:'s| is) your name\b/.test(normalized)) {
    return "I'm the ticket intake assistant for this workspace. Tell me whether this is a request or an incident and what you need help with.";
  }

  if (/\bwhere do you live\b/.test(normalized)) {
    return "I run inside this local ticket intake chatbot service. Tell me what happened or what you need and I will help you file it.";
  }

  if (/\btell me (?:a )?joke\b/.test(normalized)) {
    return "I'm focused on helping you file a support ticket. Tell me whether this is a request or an incident.";
  }

  if (/^(hi|hello|hey)\b/.test(normalized)) {
    return "Hi. Tell me whether this is a request or an incident and what happened.";
  }

  return undefined;
}

function getDeterministicCasualResponse(message: string): string | undefined {
  const normalized = message.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (/^(thanks|thank you|thx)[!. ]*$/.test(normalized)) {
    return getCasualResponse(message);
  }

  if (/^(?:hi|hello|hey)[!. ]*$/.test(normalized)) {
    return getCasualResponse(message);
  }

  if (/^how are you\??$/.test(normalized)) {
    return getCasualResponse(message);
  }

  if (/^what(?:'s| is) your name\??$/.test(normalized)) {
    return getCasualResponse(message);
  }

  if (/^where do you live\??$/.test(normalized)) {
    return getCasualResponse(message);
  }

  if (/^tell me (?:a )?joke[!. ]*$/.test(normalized)) {
    return getCasualResponse(message);
  }

  return undefined;
}

function getCreatedConversationResponse(message: string, state: ConversationState): string {
  const normalized = message.trim().toLowerCase();
  const ticketLocation = state.createdTicketUrl ? ` at ${state.createdTicketUrl}` : "";

  if (/^(thanks|thank you|thx)\b/.test(normalized)) {
    return `You're welcome. The created ticket is still available${ticketLocation}.`;
  }

  return `This ticket has already been created${ticketLocation}. Use New to start a revised ticket or another intake.`;
}

function countExtractedFields(extracted: Partial<TicketSpec>): number {
  return Object.values(extracted).filter((value) => {
    if (Array.isArray(value)) {
      return value.length > 0;
    }

    return value !== undefined && value !== null && value !== "";
  }).length;
}

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return value !== undefined && value !== null && value !== "";
}

