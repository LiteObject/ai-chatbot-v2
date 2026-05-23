# Chatbot Features

This file captures the current feature set of the support ticket intake chatbot in this repository.

## Core Purpose

- Conversational support ticket intake for internal requests and incidents.
- Local web UI backed by a Fastify server and a local Ollama model.
- Slot-filling workflow that gathers structured ticket data instead of relying on free-form LLM output alone.
- Explicit confirmation before any ticket is created.

## Architecture Features

- Slot-filling conversation flow built around a typed `TicketSpec`.
- Stateful orchestration that moves between collection, confirmation, and created states.
- Hybrid control model that combines deterministic rules with LLM-based extraction and response generation.
- Command-oriented ticket creation path that separates planning, approval, and execution.
- Repository-based persistence boundaries for conversations, commands, and learned user preferences.
- Adapter boundary for the ticketing system so the workflow stays decoupled from the concrete integration.

## Supported Ticket Model

- Two supported ticket types: `request` and `incident`.
- Bug, defect, error, outage, and similar language normalize to `incident`.
- Request-like language such as access request, password reset, or service request normalizes to `request`.
- Supported ticket fields:
  - `title`
  - `summary`
  - `ticketType`
  - `affectedUsers`
  - `affectedServices`
  - `details`
  - `impact`
  - `environment`
  - `reproductionSteps`
  - `notes`
- Strict schema validation with bounded string lengths and bounded list sizes.
- Environment normalization from natural language for:
  - `production`
  - `staging`
  - `iOS`
  - `Android`
  - `mobile`
  - `web`
  - `desktop`

## Workflow Features

- Stateful conversations keyed by `conversationId`.
- Incremental requirement extraction from each user message.
- Merge of partial extractions into a typed `TicketSpec`.
- Required-field validation that changes by ticket type.
- Clarifying-question generation when required fields are missing.
- Confirmation summary generation when the ticket is complete.
- Deterministic confirmation handling for clear `yes` and `no` replies.
- Ability to resume requirement collection if the user changes requirements while the bot is awaiting confirmation.
- Conversation bootstrap for unknown conversation IDs by returning an empty `collecting_requirements` state instead of an error.
- Post-create handling so the bot can acknowledge follow-up messages without re-creating the same ticket.

## Required-Field Rules

- Base required fields for all tickets:
  - `ticketType`
  - `summary`
- Additional required fields for `request`:
  - `affectedUsers`
  - `affectedServices`
  - `details`
- Additional required fields for `incident`:
  - `affectedUsers`
  - `affectedServices`
  - `details`
  - `impact`
- Guard against vague summaries such as `ticket`, `request`, `incident`, `bug`, `issue`, or `support`.

## Safety And Guardrails

- Content-safety assessment on user input before extraction.
- Content-safety assessment on the merged ticket spec before confirmation or execution.
- Jailbreak detection and sanitization for user messages.
- Jailbreak detection and sanitization for extracted ticket fields.
- Assistant fallback responses when content safety or jailbreak rules are triggered.
- Sensitive-data redaction for:
  - user messages
  - assistant messages
  - extracted ticket data
  - command payloads
  - ticketing-system results
  - serialized API responses
- Execution-time revalidation so a ticket cannot be created with unsafe, invalid, or incomplete data.

## Ticket Creation Features

- Ticket creation is modeled as a command instead of a direct side effect.
- Explicit human approval requirement enforced through confirmation before execution.
- Idempotent command execution using an idempotency key.
- Execution-lock protection so the same command cannot run concurrently.
- Retry with bounded exponential backoff for retryable ticketing-system failures.
- Mock internal ticketing-system adapter included by default.
- Mock ticket creation returns stable-looking IDs such as `ticket_mock_1` and URLs like `http://localhost:3000/tickets/ticket_mock_1`.

## Conversation And Preference Features

- In-memory conversation repository for active sessions.
- In-memory command repository for ticket command records.
- In-memory user preference repository.
- Automatic preference learning from completed tickets for:
  - preferred ticket type
  - preferred environment
  - preferred affected services
- Conversation messages and status persisted in memory for the lifetime of the running process.

## Local UI Features

- Split-pane layout with chat on the left and ticket summary on the right.
- Empty-state suggestion prompts for common request and incident examples.
- Live ticket summary panel with required-field indicators.
- Missing-fields checklist in the side panel.
- Runtime metrics card in the side panel.
- Runtime details in the metrics area, including:
  - active LLM model
  - estimated context usage
- Conversation ID display in the side panel.
- New-conversation button to reset the intake flow.
- Keyboard shortcut support for submit with `Ctrl+Enter` or `Cmd+Enter`.
- Local conversation ID persistence in the browser so the UI can reload the same session.
- Responsive layout that adapts the side panel for narrower screens.

## Context Window Management

- Estimated token usage based on current conversation state and ticket spec.
- Warning threshold and block threshold driven by configuration.
- Warning state when the conversation approaches the configured model context window.
- Block state when the conversation exceeds the configured safe threshold for new LLM extraction.
- Compaction of older messages into a system summary while retaining the latest turns.
- Continued deterministic handling for confirmation replies even when new LLM extraction is blocked.

## Conversational Quality-Of-Life Features

- Deterministic handling for simple conversational messages such as greetings and thanks.
- Friendly responses for small-talk messages without forcing unnecessary LLM extraction.
- Deterministic ticket-type hints from raw user phrasing.
- Deterministic environment hints from raw user phrasing.

## HTTP And Runtime Endpoints

- `GET /health`
  - Basic health probe.
- `GET /api/runtime`
  - Returns runtime metadata such as model ID and context-window settings.
- `GET /api/metrics`
  - Returns in-memory metrics for turns, extraction failures, confirmations, ticket creation, guardrails, and latency.
- `GET /api/conversations/:conversationId`
  - Returns the saved conversation state.
  - Returns an empty bootstrap conversation state for unknown IDs.
- `POST /api/chat`
  - Processes a chat turn and returns the updated conversation state.
- Static UI routes served from `src/ui` in development and `dist/ui` after build.

## Observability Features

- Structured Pino logging.
- In-memory telemetry aggregation for live metrics.
- Metrics include:
  - turns started, completed, and failed
  - turn latency
  - extraction request failures
  - structured-output failures
  - structured-output repair failures
  - confirmation prompts and decisions
  - ticket creation success and failure
  - ticketing-system latency
  - privacy redactions
  - content-safety blocks
  - jailbreak detections, blocks, and sanitizations

## Configuration Features

- Configurable Ollama base URL.
- Configurable Ollama model.
- Configurable context-window size.
- Configurable warning and block ratios for context usage.
- Configurable maximum response tokens.
- Configurable temperature.
- Configurable retry attempts and retry delays.
- Configurable server port.
- Configurable log level.

## Current Implementation Boundaries

- Uses local Ollama rather than a hosted LLM provider.
- Uses in-memory repositories rather than a database.
- Uses a mock ticketing-system client by default rather than a real external ticketing integration.
- Optimized for local development and experimentation.
