export const LIVE_EVENT_SCHEMA_VERSION = 1;

export interface LiveEvent {
  schemaVersion: number;
  source: string;
  sessionId: string;
  sequence: number;
  observedAt: string;
  type: string;
  data: unknown;
  eventId?: string;
}

export interface LiveEvidenceRecord {
  schemaVersion: number;
  id: string;
  kind: string;
  sessionId: string;
  sequence: number;
  observedAt: string;
  confidence: "observed";
  provenance: {
    adapter: "live";
    source: string;
    eventId: string;
    inputLine: number;
  };
  data: unknown;
}

export class LiveEventError extends Error {
  constructor(message: string, readonly inputLine: number) {
    super(`Live event at input line ${inputLine}: ${message}`);
    this.name = "LiveEventError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, name: string, line: number): string {
  if (typeof value[name] !== "string" || value[name].length === 0) {
    throw new LiveEventError(`${name} must be a non-empty string`, line);
  }
  return value[name];
}

export function parseLiveEvent(text: string, inputLine: number): LiveEvent | undefined {
  if (text.trim().length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LiveEventError(`invalid JSON: ${reason}`, inputLine);
  }
  if (!isObject(value)) throw new LiveEventError("must be a JSON object", inputLine);

  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== LIVE_EVENT_SCHEMA_VERSION) {
    throw new LiveEventError(`schemaVersion must be ${LIVE_EVENT_SCHEMA_VERSION}`, inputLine);
  }
  const sequence = value.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new LiveEventError("sequence must be a non-negative safe integer", inputLine);
  }
  if (!("data" in value)) throw new LiveEventError("data is required", inputLine);
  const eventId = value.eventId;
  if (eventId !== undefined && (typeof eventId !== "string" || eventId.length === 0)) {
    throw new LiveEventError("eventId must be a non-empty string when present", inputLine);
  }

  return {
    schemaVersion,
    source: requiredString(value, "source", inputLine),
    sessionId: requiredString(value, "sessionId", inputLine),
    sequence,
    observedAt: requiredString(value, "observedAt", inputLine),
    type: requiredString(value, "type", inputLine),
    data: value.data,
    ...(eventId === undefined ? {} : { eventId }),
  };
}

/**
 * Converts an append-only live source stream to immutable observed evidence.
 * One source must serialize events for a session. Rejecting duplicate or
 * regressing sequence numbers makes reconnect/replay failures visible rather
 * than silently changing a timeline.
 */
export class LiveDecomposer {
  private readonly lastSequence = new Map<string, number>();
  private readonly seenEventIds = new Set<string>();

  ingest(event: LiveEvent, inputLine: number): LiveEvidenceRecord {
    const eventId = event.eventId ?? `${event.source}:${event.sessionId}:${event.sequence}`;
    if (this.seenEventIds.has(eventId)) {
      throw new LiveEventError(`duplicate eventId ${JSON.stringify(eventId)}`, inputLine);
    }
    const sessionKey = `${event.source}\u0000${event.sessionId}`;
    const previous = this.lastSequence.get(sessionKey);
    if (previous !== undefined && event.sequence <= previous) {
      throw new LiveEventError(`sequence ${event.sequence} must be greater than previous sequence ${previous} for this source session`, inputLine);
    }
    this.seenEventIds.add(eventId);
    this.lastSequence.set(sessionKey, event.sequence);

    return {
      schemaVersion: 1,
      id: `live:${event.source}:${event.sessionId}:${event.sequence}`,
      kind: event.type,
      sessionId: event.sessionId,
      sequence: event.sequence,
      observedAt: event.observedAt,
      confidence: "observed",
      provenance: {
        adapter: "live",
        source: event.source,
        eventId,
        inputLine,
      },
      data: event.data,
    };
  }
}
