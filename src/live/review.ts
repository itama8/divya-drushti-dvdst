import { classifyCommandWithReasons } from "../pi/classify-commands.js";
import type { LiveEvent } from "./decompose.js";

export interface ReviewReadyRecord {
  schemaVersion: 1;
  kind: "review-ready";
  confidence: "inferred";
  sessionId: string;
  settledAt: string;
  mutations: Array<{
    path: string;
    operation: "edit" | "write";
    toolCallId: string;
    sourceEventId: string;
    resultEventId: string;
  }>;
  validation: {
    testsAfterFinalMutation: "passed" | "failed" | "not-observed";
    commandsFailed: Array<{ command: string; toolCallId: string; sourceEventId: string }>;
  };
  evidence: string[];
  limit: string;
}

interface StartedTool {
  toolName: string;
  args: Record<string, unknown>;
  sourceEventId: string;
}

interface Mutation {
  path: string;
  operation: "edit" | "write";
  toolCallId: string;
  sourceEventId: string;
  resultEventId: string;
  sequence: number;
}

interface CommandFailure {
  command: string;
  toolCallId: string;
  sourceEventId: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventId(event: LiveEvent): string {
  return event.eventId ?? `${event.source}:${event.sessionId}:${event.sequence}`;
}

function toolStarted(event: LiveEvent): { toolCallId: string; toolName: string; args: Record<string, unknown> } | undefined {
  if (event.type !== "tool.started" || !isObject(event.data)) return undefined;
  const { toolCallId, toolName, args } = event.data;
  if (typeof toolCallId !== "string" || typeof toolName !== "string" || !isObject(args)) return undefined;
  return { toolCallId, toolName, args };
}

function toolFinished(event: LiveEvent): { toolCallId: string; isError: boolean } | undefined {
  if (event.type !== "tool.finished" || !isObject(event.data)) return undefined;
  const { toolCallId, isError } = event.data;
  if (typeof toolCallId !== "string" || typeof isError !== "boolean") return undefined;
  return { toolCallId, isError };
}

/**
 * Reduces observe-only Pi lifecycle events into review handoff frames.
 * A frame is emitted only once Pi reports that the agent has settled. It points
 * at completed mutations and validation evidence, but it never claims a diff or
 * a semantic code-review result.
 */
export class LiveReviewReducer {
  private readonly startedTools = new Map<string, StartedTool>();
  private readonly mutations: Mutation[] = [];
  private readonly failedCommands: CommandFailure[] = [];
  private lastSuccessfulTestSequence: number | undefined;

  ingest(event: LiveEvent): ReviewReadyRecord | undefined {
    const started = toolStarted(event);
    if (started) {
      this.startedTools.set(started.toolCallId, {
        toolName: started.toolName,
        args: started.args,
        sourceEventId: eventId(event),
      });
      return undefined;
    }

    const finished = toolFinished(event);
    if (finished) {
      const startedTool = this.startedTools.get(finished.toolCallId);
      this.startedTools.delete(finished.toolCallId);
      if (startedTool === undefined) return undefined;

      if ((startedTool.toolName === "edit" || startedTool.toolName === "write") && !finished.isError) {
        const path = startedTool.args.path;
        if (typeof path === "string" && path.length > 0) {
          this.mutations.push({
            path,
            operation: startedTool.toolName,
            toolCallId: finished.toolCallId,
            sourceEventId: startedTool.sourceEventId,
            resultEventId: eventId(event),
            sequence: event.sequence,
          });
        }
      }

      if (startedTool.toolName === "bash") {
        const command = startedTool.args.command;
        if (typeof command === "string") {
          const isTest = classifyCommandWithReasons(command).some((classification) => classification.name === "test");
          if (isTest && !finished.isError) this.lastSuccessfulTestSequence = event.sequence;
          if (finished.isError) {
            this.failedCommands.push({ command, toolCallId: finished.toolCallId, sourceEventId: eventId(event) });
          }
        }
      }
      return undefined;
    }

    if (event.type !== "agent.settled" || this.mutations.length === 0) return undefined;
    const finalMutation = this.mutations.at(-1)!;
    const testsAfterFinalMutation = this.lastSuccessfulTestSequence === undefined
      ? "not-observed"
      : this.lastSuccessfulTestSequence > finalMutation.sequence
        ? "passed"
        : "not-observed";
    const record: ReviewReadyRecord = {
      schemaVersion: 1,
      kind: "review-ready",
      confidence: "inferred",
      sessionId: event.sessionId,
      settledAt: event.observedAt,
      mutations: this.mutations.map(({ sequence: _sequence, ...mutation }) => mutation),
      validation: {
        testsAfterFinalMutation,
        commandsFailed: [...this.failedCommands],
      },
      evidence: [
        ...this.mutations.map((mutation) => mutation.resultEventId),
        ...this.failedCommands.map((failure) => failure.sourceEventId),
      ],
      limit: "This frame lists completed tool operations from the observed stream. It does not prove the repository diff, isolate concurrent writers, or provide a semantic code review.",
    };
    this.mutations.length = 0;
    this.failedCommands.length = 0;
    return record;
  }
}
