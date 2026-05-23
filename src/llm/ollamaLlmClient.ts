import type { AppConfig } from "../config";
import { partialTicketSpecSchema, type PartialTicketSpec } from "../domain/ticketSpec";
import { getErrorAttributes, noopTelemetry, type Telemetry } from "../observability/telemetry";
import { isRetryableServiceError, withRetry } from "../reliability/retry";
import type {
    ClarifyingQuestionInput,
    ConfirmationSummaryInput,
    ExtractTicketSpecInput,
    LlmClient
} from "./llmClient";
import {
    buildClarifyingQuestionPrompt,
    buildConfirmationSummaryPrompt,
    buildExtractionPrompt,
    buildJsonRepairPrompt
} from "./prompts";
import { parseJsonWithSchema } from "./structuredJson";
import { normalizeAssistantText } from "./textOutput";

export interface OllamaFetchResponse {
    ok: boolean;
    status: number;
    statusText: string;
    text(): Promise<string>;
}

export type OllamaFetch = (
    input: string | URL,
    init: {
        method: string;
        headers: Record<string, string>;
        body: string;
    }
) => Promise<OllamaFetchResponse>;

interface OllamaChatMessage {
    role: "system" | "user";
    content: string;
}

interface OllamaChatRequest {
    model: string;
    messages: OllamaChatMessage[];
    stream: false;
    options: {
        temperature: number;
        num_predict: number;
    };
    format?: "json";
}

class OllamaApiError extends Error {
    readonly $metadata: { httpStatusCode: number };

    constructor(message: string, statusCode: number) {
        super(message);
        this.name = "OllamaApiError";
        this.$metadata = { httpStatusCode: statusCode };
    }
}

export class OllamaLlmClient implements LlmClient {
    private readonly fetchImpl: OllamaFetch;

    constructor(
        private readonly config: AppConfig,
        private readonly telemetry: Telemetry = noopTelemetry,
        fetchImpl?: OllamaFetch
    ) {
        const defaultFetch = globalThis.fetch;

        if (typeof defaultFetch !== "function" && !fetchImpl) {
            throw new Error("Global fetch is unavailable. Provide a fetch implementation to OllamaLlmClient.");
        }

        this.fetchImpl = fetchImpl ?? (defaultFetch as unknown as OllamaFetch);
    }

    async extractTicketSpec(input: ExtractTicketSpecInput): Promise<PartialTicketSpec> {
        const text = await this.sendText(
            "You extract structured support ticket requirements and return strict JSON.",
            buildExtractionPrompt(input.userMessage, input.currentSpec, input.missingFields),
            { json: true }
        );

        try {
            return parseJsonWithSchema(text, partialTicketSpecSchema);
        } catch (error) {
            this.telemetry.event("llm_structured_output_validation_failed", {
                task: "extract_ticket_spec",
                ...getErrorAttributes(error)
            });
            this.telemetry.metric("llm_structured_output_failure_count", 1, {
                task: "extract_ticket_spec"
            });

            const repaired = await this.sendText(
                "You repair malformed JSON and return strict JSON only.",
                buildJsonRepairPrompt(text),
                { json: true }
            );

            try {
                return parseJsonWithSchema(repaired, partialTicketSpecSchema);
            } catch (repairError) {
                this.telemetry.event("llm_structured_output_repair_failed", {
                    task: "extract_ticket_spec",
                    ...getErrorAttributes(repairError)
                });
                this.telemetry.metric("llm_structured_output_repair_failure_count", 1, {
                    task: "extract_ticket_spec"
                });
                return {};
            }
        }
    }

    async generateClarifyingQuestion(input: ClarifyingQuestionInput): Promise<string> {
        const text = await this.sendText(
            "You ask concise support ticket intake questions.",
            buildClarifyingQuestionPrompt(input.ticketSpec, input.missingFields)
        );

        return normalizeAssistantText(text);
    }

    async generateConfirmationSummary(input: ConfirmationSummaryInput): Promise<string> {
        const text = await this.sendText(
            "You summarize ticket specifications for final confirmation.",
            buildConfirmationSummaryPrompt(input.ticketSpec)
        );

        return normalizeAssistantText(text);
    }

    private async sendText(
        systemPrompt: string,
        userPrompt: string,
        options: { maxTokens?: number; json?: boolean } = {}
    ): Promise<string> {
        const response = await withRetry(() => this.chat({
            systemPrompt,
            userPrompt,
            maxTokens: options.maxTokens ?? this.config.ollamaMaxTokens,
            json: options.json ?? false
        }), {
            attempts: this.config.ollamaRetryAttempts,
            baseDelayMs: this.config.ollamaRetryBaseDelayMs,
            maxDelayMs: this.config.ollamaRetryMaxDelayMs,
            shouldRetry: isRetryableOllamaError,
            onRetry: (error, attempt, delayMs) => {
                this.telemetry.event("llm_request_retry_scheduled", {
                    modelId: this.config.ollamaModel,
                    attempt,
                    nextAttempt: attempt + 1,
                    delayMs,
                    ...getErrorAttributes(error)
                });
            }
        });

        return response;
    }

    private async chat(input: {
        systemPrompt: string;
        userPrompt: string;
        maxTokens: number;
        json: boolean;
    }): Promise<string> {
        const request: OllamaChatRequest = {
            model: this.config.ollamaModel,
            messages: [
                {
                    role: "system",
                    content: input.systemPrompt
                },
                {
                    role: "user",
                    content: input.userPrompt
                }
            ],
            stream: false,
            options: {
                temperature: this.config.ollamaTemperature,
                num_predict: input.maxTokens
            }
        };

        if (input.json) {
            request.format = "json";
        }

        const response = await this.fetchImpl(new URL("/api/chat", this.config.ollamaBaseUrl), {
            method: "POST",
            headers: {
                "content-type": "application/json"
            },
            body: JSON.stringify(request)
        });
        const responseText = await response.text();

        if (!response.ok) {
            throw new OllamaApiError(extractOllamaErrorMessage(responseText, response.status, response.statusText), response.status);
        }

        return extractAssistantContent(responseText);
    }
}

function isRetryableOllamaError(error: unknown): boolean {
    return isRetryableServiceError(error)
        || error instanceof TypeError
        || (error instanceof Error && error.name === "AbortError");
}

function extractAssistantContent(responseText: string): string {
    const parsed: unknown = JSON.parse(responseText);

    if (!isRecord(parsed)) {
        throw new Error("Ollama response was not a JSON object.");
    }

    const message = parsed.message;

    if (!isRecord(message) || typeof message.content !== "string") {
        throw new Error("Ollama response was missing assistant content.");
    }

    return message.content.trim();
}

function extractOllamaErrorMessage(responseText: string, status: number, statusText: string): string {
    const fallback = `Ollama request failed with status ${status}${statusText ? ` ${statusText}` : ""}.`;
    const trimmed = responseText.trim();

    if (!trimmed) {
        return fallback;
    }

    try {
        const parsed: unknown = JSON.parse(trimmed);

        if (isRecord(parsed)) {
            const error = parsed.error;

            if (typeof error === "string" && error.trim()) {
                return error.trim();
            }

            const message = parsed.message;

            if (typeof message === "string" && message.trim()) {
                return message.trim();
            }
        }
    } catch {
        return trimmed;
    }

    return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}
