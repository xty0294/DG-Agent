/**
 * conversation.ts — Top-level session orchestration.
 *
 * Owns:
 *   1. ConversationStore: a clean stream of user/assistant text items
 *      (no tool items, no synthetic notes — those live inside the runner)
 *   2. ChatSink: a per-sendMessage adapter that turns runner events into
 *      concrete UI callback calls and manages bubble lifecycle
 *   3. sendMessage: the only public mutation entry point
 *
 * conversation.ts no longer touches prompt strings, no longer mutates the
 * input array, no longer holds streaming state in closures.
 */

import type { AgentSink, ConversationItem, ConversationRecord } from '../types';
import * as history from './history';
import { buildInstructions } from './prompts';
import { tools, executeTool } from './tools';
import * as bt from './bluetooth';
import { runTurn } from './runner';
import { resolveProviderConfig } from './transport';

// ---------------------------------------------------------------------------
// UI callback contract
// ---------------------------------------------------------------------------

export interface ConversationCallbacks {
  onUserMessage: (text: string) => void;
  onAssistantStream: (text: string, msgId?: string) => string;
  onAssistantFinalize: (msgId: string) => void;
  onAssistantDiscard: (msgId: string) => void;
  onToolCall: (name: string, args: Record<string, unknown>, result: string) => void;
  onTypingStart: () => void;
  onTypingEnd: () => void;
  onError: (message: string) => void;
  onHistoryChange: () => void;
}

let callbacks: ConversationCallbacks | null = null;

export function registerCallbacks(cb: ConversationCallbacks): void {
  callbacks = cb;
}

// ---------------------------------------------------------------------------
// ConversationStore — pure user/assistant text stream
// ---------------------------------------------------------------------------

const MAX_ITEMS = 200;

const store = {
  items: [] as ConversationItem[],
  current: null as ConversationRecord | null,
  isProcessing: false,
  activePresetId: 'gentle',
};

/** Strip non-text items (legacy data: function_call / function_call_output). */
function sanitize(items: readonly ConversationItem[]): ConversationItem[] {
  return items.filter((it: any) => it.role === 'user' || it.role === 'assistant');
}

function pruneItems(): void {
  if (store.items.length <= MAX_ITEMS) return;
  store.items.splice(0, store.items.length - MAX_ITEMS);
}

// ---------------------------------------------------------------------------
// Read-only accessors
// ---------------------------------------------------------------------------

export function getHistory(): readonly ConversationItem[] {
  return store.items;
}

export function getCurrentConversation(): ConversationRecord | null {
  return store.current;
}

export function getActivePresetId(): string {
  return store.activePresetId;
}

export function setActivePresetId(id: string): void {
  store.activePresetId = id;
}

export function getIsProcessing(): boolean {
  return store.isProcessing;
}

export function loadConversation(conv: ConversationRecord): void {
  store.items = sanitize(conv.items);
  store.current = conv;
  store.activePresetId = conv.presetId || 'gentle';
}

export function startNewConversation(): void {
  store.items = [];
  store.current = null;
}

// ---------------------------------------------------------------------------
// ChatSink — per-sendMessage UI adapter
// ---------------------------------------------------------------------------

class ChatSink implements AgentSink {
  private cb: ConversationCallbacks;
  private msgId: string | null = null;

  constructor(cb: ConversationCallbacks) {
    this.cb = cb;
  }

  /** Drop any in-flight bubble without finalizing (used on error). */
  discardPendingBubble(): void {
    if (this.msgId) {
      this.cb.onAssistantDiscard(this.msgId);
      this.msgId = null;
    }
  }

  // ---- AgentSink interface ----

  onTextDelta(accumulated: string): void {
    this.cb.onTypingEnd();
    this.msgId = this.cb.onAssistantStream(accumulated, this.msgId || undefined);
  }

  onTextComplete(): void {
    if (this.msgId) {
      this.cb.onAssistantFinalize(this.msgId);
      this.msgId = null;
    }
  }

  onTextDiscard(): void {
    this.discardPendingBubble();
    this.cb.onTypingStart();
  }

  onTextInline(text: string): void {
    if (!text) return;
    this.discardPendingBubble();
    const id = this.cb.onAssistantStream(text, undefined);
    this.cb.onAssistantFinalize(id);
  }

  onToolCall(name: string, args: Record<string, unknown>, result: string): void {
    // If there was streamed text before the tool call ("narrate then act"),
    // lock that bubble in before showing the tool notification.
    this.onTextComplete();
    console.log(`[Tool → ${name}]`, JSON.stringify(args));
    console.log(`[Tool ← ${name}]`, result);
    this.cb.onToolCall(name, args, result);
    this.cb.onTypingStart();
  }
}

// ---------------------------------------------------------------------------
// sendMessage — the only mutation entry point
// ---------------------------------------------------------------------------

export async function sendMessage(text: string, customPrompt: string): Promise<void> {
  if (store.isProcessing || !callbacks) return;
  store.isProcessing = true;

  const cb = callbacks;
  cb.onUserMessage(text);
  store.items.push({ role: 'user', content: text });

  if (!store.current) {
    store.current = history.createConversation(store.activePresetId);
  }

  const sink = new ChatSink(cb);
  cb.onTypingStart();

  try {
    const finalItems = await runTurn({
      conversationItems: store.items,
      buildInstructions: (deviceStatus, isFirstIteration) =>
        buildInstructions({
          presetId: store.activePresetId,
          customPrompt,
          deviceStatus,
          isFirstIteration,
        }),
      getDeviceStatus: bt.getStatus,
      tools,
      executor: executeTool,
      transportConfig: resolveProviderConfig(),
      sink,
    });

    store.items.push(...finalItems);
  } catch (err: any) {
    console.error('[conversation] runTurn failed:', err);
    // Drop any in-flight streamed bubble before showing the error so the
    // user doesn't see a half-finished message hanging above the error.
    sink.discardPendingBubble();
    const message = err?.message || String(err);
    cb.onError(message);
    // Persist the error as an assistant item so reloads show a complete
    // user/assistant pair instead of an orphan user message at the tail.
    store.items.push({ role: 'assistant', content: `出错了: ${message}` });
  } finally {
    cb.onTypingEnd();

    if (store.current) {
      store.current.items = [...store.items];
      store.current.title = history.generateTitle(store.items);
      store.current.updatedAt = Date.now();
      history.saveConversation(store.current);
      cb.onHistoryChange();
    }

    pruneItems();
    store.isProcessing = false;
  }
}
