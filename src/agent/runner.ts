/**
 * runner.ts — Agent tool-call loop.
 *
 * One `runTurn` invocation handles a single user turn:
 *   - Iterates LLM calls until the model produces a final assistant text
 *   - Executes tool calls between iterations
 *   - Enforces all per-turn hard caps from `policies.ts`
 *   - Runs the hallucination guard on candidate final replies
 *   - Streams text + tool events through the AgentSink
 *
 * The runner owns one piece of state (`RunnerState`) that lives only for the
 * duration of one `runTurn` call. Nothing escapes — only the final assistant
 * text item(s) are returned for persistence.
 */

import type { AgentSink, ConversationItem, DeviceState, ToolDef } from '../types';
import {
  MAX_TOOL_ITERATIONS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_ADD_STRENGTH_PER_TURN,
  MAX_HALLUCINATION_CORRECTIONS_PER_TURN,
  isMutatingTool,
  detectHallucination,
  buildHallucinationCorrectionNote,
} from './policies';
import { callResponses, type TransportConfig } from './transport';

// ---------------------------------------------------------------------------
// Runner input contract
// ---------------------------------------------------------------------------

export interface RunTurnInput {
  /** The pristine conversation history (user/assistant text only). */
  conversationItems: readonly ConversationItem[];
  /** Builds the system instructions for one iteration. Called every iter. */
  buildInstructions: (deviceStatus: DeviceState, isFirstIteration: boolean) => string;
  /** Reads the latest device status. Called every iter so the LLM sees fresh state. */
  getDeviceStatus: () => DeviceState;
  /** Tool schemas for the LLM. */
  tools: ToolDef[];
  /** Executes a tool by name. Errors must be returned as JSON, not thrown. */
  executor: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Provider/transport configuration. */
  transportConfig: TransportConfig;
  /** UI sink for streaming + tool notifications. */
  sink: AgentSink;
}

// ---------------------------------------------------------------------------
// Internal per-turn state
// ---------------------------------------------------------------------------

interface RunnerState {
  /** Items appended during this turn (tool calls, outputs, correction notes). */
  workingItems: ConversationItem[];
  /** Total tool calls so far this turn (any tool). */
  totalToolCalls: number;
  /** add_strength calls so far this turn. */
  addStrengthCalls: number;
  /** True if any tool was called (incl. get_status). */
  anyToolCalled: boolean;
  /** True if a *mutating* tool was called this turn. */
  mutatingToolCalled: boolean;
  /** Number of hallucination corrections already issued this turn. */
  correctionsUsed: number;
}

function newState(): RunnerState {
  return {
    workingItems: [],
    totalToolCalls: 0,
    addStrengthCalls: 0,
    anyToolCalled: false,
    mutatingToolCalled: false,
    correctionsUsed: 0,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run one user turn. Returns the items that should be persisted into the
 * conversation history — typically a single `{role:'assistant'}` item.
 * Tool items and correction notes stay inside the runner and never leak.
 */
export async function runTurn(input: RunTurnInput): Promise<ConversationItem[]> {
  const state = newState();

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    const deviceStatus = input.getDeviceStatus();
    const instructions = input.buildInstructions(deviceStatus, iter === 0);
    const llmInput: ConversationItem[] = [
      ...input.conversationItems,
      ...state.workingItems,
    ];

    const { outputItems, streamedText } = await callResponses(
      llmInput,
      instructions,
      input.tools,
      input.transportConfig,
      input.sink.onTextDelta.bind(input.sink),
    );

    const fnCalls = outputItems.filter((o: any) => o.type === 'function_call');

    if (fnCalls.length > 0) {
      await handleToolCalls(fnCalls, streamedText, state, input);
      continue;
    }

    // No tool calls — this is a candidate final answer.
    const verdict = detectHallucination(streamedText, state);
    if (verdict && state.correctionsUsed < MAX_HALLUCINATION_CORRECTIONS_PER_TURN) {
      state.correctionsUsed++;
      console.warn(
        `[runner] Hallucination guard triggered (${verdict.kind}): "${verdict.matched}". Discarding reply and re-prompting.`,
      );
      input.sink.onTextDiscard();
      state.workingItems.push({
        role: 'user',
        content: buildHallucinationCorrectionNote(verdict.kind),
      });
      continue;
    }

    // Accept the reply. Lock the bubble and return the persistable item.
    input.sink.onTextComplete();
    return [{ role: 'assistant', content: streamedText }];
  }

  // Iteration ceiling reached. The model spent all iterations on tool calls
  // without producing a final reply. Show an explicit sentinel so the user
  // sees that the agent gave up rather than a silent stop.
  const sentinel = '[已达本回合工具调用上限，请重新发起对话]';
  input.sink.onTextDiscard();
  input.sink.onTextInline(sentinel);
  return [{ role: 'assistant', content: sentinel }];
}

// ---------------------------------------------------------------------------
// Tool execution sub-step
// ---------------------------------------------------------------------------

async function handleToolCalls(
  fnCalls: any[],
  streamedText: string,
  state: RunnerState,
  input: RunTurnInput,
): Promise<void> {
  // Any text the model emitted before the tool calls (the "narrate then act"
  // pattern). Lock that bubble in so the next iter starts a fresh one.
  if (streamedText) {
    input.sink.onTextComplete();
    state.workingItems.push({ role: 'assistant', content: streamedText });
  }

  // Push all function_call items first so the LLM input contains call/output
  // pairs in the right order on the next iteration.
  for (const fc of fnCalls) {
    state.workingItems.push({
      type: 'function_call',
      call_id: fc.call_id,
      name: fc.name,
      arguments: fc.arguments,
    });
  }

  for (const fc of fnCalls) {
    const args = parseArgs(fc.arguments);
    const result = await executeOneCall(fc.name, args, state, input);

    state.workingItems.push({
      type: 'function_call_output',
      call_id: fc.call_id,
      output: result,
    });

    input.sink.onToolCall(fc.name, args, result);
  }
}

async function executeOneCall(
  name: string,
  args: Record<string, unknown>,
  state: RunnerState,
  input: RunTurnInput,
): Promise<string> {
  // Hard cap: total tool calls per turn
  if (state.totalToolCalls >= MAX_TOOL_CALLS_PER_TURN) {
    return JSON.stringify({
      error: `本回合工具调用总数已达上限 (${MAX_TOOL_CALLS_PER_TURN})，本次调用被拒绝。请直接回复用户，不要再发起工具调用。`,
    });
  }

  // Hard cap: add_strength per turn
  if (name === 'add_strength' && state.addStrengthCalls >= MAX_ADD_STRENGTH_PER_TURN) {
    return JSON.stringify({
      error: `add_strength 本回合调用已达上限 (${MAX_ADD_STRENGTH_PER_TURN} 次)，本次调用被拒绝。本回合已经调整过足够多次了，请直接回复用户，不要再继续爬升强度。`,
    });
  }

  // Count it (even on executor failure — the model already attempted it)
  state.totalToolCalls++;
  state.anyToolCalled = true;
  if (isMutatingTool(name)) state.mutatingToolCalled = true;
  if (name === 'add_strength') state.addStrengthCalls++;

  try {
    const result = await input.executor(name, args);
    return typeof result === 'string' ? result : JSON.stringify(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return JSON.stringify({ error: message });
  }
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}
