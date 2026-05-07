import type { ConversationState } from "./conversationState";

export type ContextWindowStatus = "ok" | "warning" | "blocked";

export interface ContextWindowOptions {
  maxTokens: number;
  warningRatio: number;
  blockRatio: number;
}

export interface ContextWindowUsage {
  usedTokens: number;
  maxTokens: number;
  usedRatio: number;
  warningThresholdTokens: number;
  blockThresholdTokens: number;
  status: ContextWindowStatus;
}

export const defaultContextWindowOptions: ContextWindowOptions = {
  maxTokens: 200000,
  warningRatio: 0.8,
  blockRatio: 0.95
};

const retainedMessageCount = 8;

export function getContextWindowUsage(
  state: ConversationState,
  options: ContextWindowOptions = defaultContextWindowOptions
): ContextWindowUsage {
  const normalizedOptions = normalizeContextWindowOptions(options);
  const usedTokens = estimateTokens(JSON.stringify(buildContextPayload(state)));
  const warningThresholdTokens = Math.max(1, Math.floor(normalizedOptions.maxTokens * normalizedOptions.warningRatio));
  const blockThresholdTokens = Math.max(1, Math.floor(normalizedOptions.maxTokens * normalizedOptions.blockRatio));
  const usedRatio = usedTokens / normalizedOptions.maxTokens;

  return {
    usedTokens,
    maxTokens: normalizedOptions.maxTokens,
    usedRatio,
    warningThresholdTokens,
    blockThresholdTokens,
    status: getContextWindowStatus(usedTokens, warningThresholdTokens, blockThresholdTokens)
  };
}

export function compactConversationForContext(
  state: ConversationState,
  options: ContextWindowOptions = defaultContextWindowOptions
): boolean {
  const usage = getContextWindowUsage(state, options);

  if (usage.status === "ok" || state.messages.length <= retainedMessageCount + 1) {
    return false;
  }

  const retainedMessages = state.messages.slice(-retainedMessageCount);
  const compactedCount = state.messages.length - retainedMessages.length;

  state.messages = [
    {
      role: "system",
      content: `Earlier ${compactedCount} messages were compacted into the current app spec to keep this conversation within the model context window.`,
      createdAt: new Date().toISOString()
    },
    ...retainedMessages
  ];

  return true;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildContextPayload(state: ConversationState) {
  return {
    status: state.status,
    messages: state.messages.map((message) => ({
      role: message.role,
      content: message.content
    })),
    appSpec: state.appSpec,
    missingFields: state.missingFields
  };
}

function normalizeContextWindowOptions(options: ContextWindowOptions): ContextWindowOptions {
  const maxTokens = Number.isFinite(options.maxTokens) && options.maxTokens > 0
    ? Math.floor(options.maxTokens)
    : defaultContextWindowOptions.maxTokens;
  const warningRatio = Number.isFinite(options.warningRatio) && options.warningRatio > 0 && options.warningRatio < 1
    ? options.warningRatio
    : defaultContextWindowOptions.warningRatio;
  const blockRatio = Number.isFinite(options.blockRatio) && options.blockRatio > warningRatio && options.blockRatio <= 1
    ? options.blockRatio
    : defaultContextWindowOptions.blockRatio;

  return {
    maxTokens,
    warningRatio,
    blockRatio
  };
}

function getContextWindowStatus(
  usedTokens: number,
  warningThresholdTokens: number,
  blockThresholdTokens: number
): ContextWindowStatus {
  if (usedTokens >= blockThresholdTokens) {
    return "blocked";
  }

  if (usedTokens >= warningThresholdTokens) {
    return "warning";
  }

  return "ok";
}