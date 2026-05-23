import type { TicketSpec, PartialTicketSpec } from "../domain/ticketSpec";

export interface ExtractTicketSpecInput {
  userMessage: string;
  currentSpec: TicketSpec;
  missingFields: string[];
}

export interface ClarifyingQuestionInput {
  ticketSpec: TicketSpec;
  missingFields: string[];
}

export interface ConfirmationSummaryInput {
  ticketSpec: TicketSpec;
}

export interface LlmClient {
  extractTicketSpec(input: ExtractTicketSpecInput): Promise<PartialTicketSpec>;
  generateClarifyingQuestion(input: ClarifyingQuestionInput): Promise<string>;
  generateConfirmationSummary(input: ConfirmationSummaryInput): Promise<string>;
}

