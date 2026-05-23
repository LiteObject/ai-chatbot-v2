import { describe, expect, it } from "vitest";
import { normalizeTicketEnvironment, partialTicketSpecSchema } from "../../src/domain/ticketSpec";

describe("partialTicketSpecSchema", () => {
    it("maps bug-like ticket types to incident", () => {
        expect(partialTicketSpecSchema.parse({ ticketType: "bug" })).toEqual({
            ticketType: "incident"
        });
    });

    it("extracts environment details mixed into the ticket type field", () => {
        expect(partialTicketSpecSchema.parse({ ticketType: "production bug" })).toEqual({
            ticketType: "incident",
            environment: "production"
        });
    });

    it("does not treat portal names as web environments", () => {
        expect(normalizeTicketEnvironment("payroll portal")).toBeUndefined();
    });

    it("leaves unsupported categories unset instead of inventing a flow", () => {
        expect(partialTicketSpecSchema.parse({ ticketType: "question" })).toEqual({});
    });

    it("rejects model-invented fields", () => {
        expect(() => partialTicketSpecSchema.parse({
            title: "Sign-in failure on payroll portal",
            summary: "users cannot sign in",
            unexpectedAction: "create the ticket now"
        })).toThrow();
    });

    it("rejects oversized list output", () => {
        const tooManyServices = [...Array(26).keys()].map((index) => `service ${index}`);

        expect(() => partialTicketSpecSchema.parse({
            affectedServices: tooManyServices
        })).toThrow();
    });
});