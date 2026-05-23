import type { TicketCommandRecord } from "../workflow/ticketCommand";

export interface TicketCommandRepository {
  get(commandId: string): Promise<TicketCommandRecord | undefined>;
  save(record: TicketCommandRecord): Promise<void>;
  listByConversationId(conversationId: string): Promise<TicketCommandRecord[]>;
  tryAcquireExecutionLock(commandId: string): Promise<boolean>;
  releaseExecutionLock(commandId: string): Promise<void>;
}
