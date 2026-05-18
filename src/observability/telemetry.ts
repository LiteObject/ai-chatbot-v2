import type { FastifyBaseLogger } from "fastify";
import { redactSensitiveValue } from "../privacy/redaction";

export type TelemetryValue = string | number | boolean | null | undefined | string[];
export type TelemetryAttributes = Record<string, TelemetryValue>;

export interface Telemetry {
  event(name: string, attributes?: TelemetryAttributes): void;
  metric(name: string, value: number, attributes?: TelemetryAttributes): void;
}

export const noopTelemetry: Telemetry = {
  event() {},
  metric() {}
};

export function createCompositeTelemetry(...telemetries: Telemetry[]): Telemetry {
  return {
    event(name, attributes = {}) {
      const redactedAttributes = redactTelemetryAttributes(attributes);
      for (const telemetry of telemetries) {
        telemetry.event(name, redactedAttributes);
      }
    },
    metric(name, value, attributes = {}) {
      const redactedAttributes = redactTelemetryAttributes(attributes);
      for (const telemetry of telemetries) {
        telemetry.metric(name, value, redactedAttributes);
      }
    }
  };
}

export function createLoggerTelemetry(logger: FastifyBaseLogger): Telemetry {
  return {
    event(name, attributes = {}) {
      logger.info({ event: name, ...redactTelemetryAttributes(attributes) }, name);
    },
    metric(name, value, attributes = {}) {
      logger.info({ metric: name, value, ...redactTelemetryAttributes(attributes) }, name);
    }
  };
}

export function getErrorAttributes(error: unknown): TelemetryAttributes {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: redactSensitiveValue(error.message).value
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: redactSensitiveValue(String(error)).value
  };
}

export function redactTelemetryAttributes(attributes: TelemetryAttributes): TelemetryAttributes {
  return compactAttributes(redactSensitiveValue(attributes).value as TelemetryAttributes);
}

function compactAttributes(attributes: TelemetryAttributes): TelemetryAttributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined)
  );
}