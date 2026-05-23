import { z } from "zod";
import { ticketSpecSchema } from "../domain/ticketSpec";

const ticketingSystemStringSchema = z.string().trim().min(1).max(500);

export const createTicketRequestSchema = z.object({
  idempotencyKey: ticketingSystemStringSchema,
  conversationId: ticketingSystemStringSchema,
  requestedBy: ticketingSystemStringSchema.optional().nullable(),
  ticketSpec: ticketSpecSchema
}).strict();

export const createTicketResultSchema = z.object({
  status: z.literal("created"),
  ticketId: ticketingSystemStringSchema,
  url: z.string().trim().url().max(2000)
}).strict();

export type CreateTicketRequest = z.infer<typeof createTicketRequestSchema>;
export type CreateTicketResult = z.infer<typeof createTicketResultSchema>;

export interface TicketingSystemClient {
  createTicket(request: CreateTicketRequest): Promise<CreateTicketResult>;
}

