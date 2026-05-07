import type { FastifyInstance } from "fastify";
import type { MetricsSnapshotProvider } from "../observability/inMemoryTelemetryAggregator";

export interface MetricsRouteDependencies {
  metrics: MetricsSnapshotProvider;
}

export async function registerMetricsRoutes(server: FastifyInstance, dependencies: MetricsRouteDependencies): Promise<void> {
  server.get("/api/metrics", async () => dependencies.metrics.snapshot());
}