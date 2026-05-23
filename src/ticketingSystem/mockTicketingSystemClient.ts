import type { TicketingSystemClient, CreateTicketRequest, CreateTicketResult } from "./ticketingSystemClient";

export class MockTicketingSystemClient implements TicketingSystemClient {
  private counter = 0;
  readonly requests: CreateTicketRequest[] = [];

  async createTicket(request: CreateTicketRequest): Promise<CreateTicketResult> {
    this.counter += 1;
    this.requests.push(structuredClone(request));

    const ticketId = `ticket_mock_${this.counter}`;
    return {
      status: "created",
      ticketId,
      url: `http://localhost:3000/tickets/${ticketId}`
    };
  }
}

