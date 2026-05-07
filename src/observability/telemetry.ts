import type { FastifyBaseLogger } from "fastify";

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
      for (const telemetry of telemetries) {
        telemetry.event(name, attributes);
      }
    },
    metric(name, value, attributes = {}) {
      for (const telemetry of telemetries) {
        telemetry.metric(name, value, attributes);
      }
    }
  };
}

export function createLoggerTelemetry(logger: FastifyBaseLogger): Telemetry {
  return {
    event(name, attributes = {}) {
      logger.info({ event: name, ...compactAttributes(attributes) }, name);
    },
    metric(name, value, attributes = {}) {
      logger.info({ metric: name, value, ...compactAttributes(attributes) }, name);
    }
  };
}

export function getErrorAttributes(error: unknown): TelemetryAttributes {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message
    };
  }

  return {
    errorName: "UnknownError",
    errorMessage: String(error)
  };
}

function compactAttributes(attributes: TelemetryAttributes): TelemetryAttributes {
  return Object.fromEntries(
    Object.entries(attributes).filter(([, value]) => value !== undefined)
  );
}