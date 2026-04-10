/**
 * transport.ts — Pure HTTP/SSE wrapper around the OpenAI Responses API.
 *
 * This module knows nothing about prompts, tools, policies, or the agent
 * loop. It accepts a fully-built `instructions` string + a clean `input`
 * array and returns the parsed output items. Provider-specific routing
 * (free / qwen / openai / custom) lives here as well so the runner stays
 * provider-agnostic.
 */

import type { ConversationItem, ToolDef } from '../types';
import { loadSettings } from './providers';

const FREE_PROXY_URL    = 'https://dg-agent-proxy.0xnullai.workers.dev';
const FREE_PROXY_URL_CN = 'https://dg-agent-proxy-eloracuikl.cn-hangzhou.fcapp.run';

// ---------------------------------------------------------------------------
// Provider config resolution
// ---------------------------------------------------------------------------

export interface TransportConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  providerId: string;
}

export function resolveProviderConfig(): TransportConfig {
  const settings = loadSettings();
  const providerId = settings.provider || 'free';
  const raw = { ...(settings.configs?.[providerId] || {}) };

  let baseUrl = raw.baseUrl || '';
  let apiKey = raw.apiKey || '';
  let model = raw.model || '';

  if (providerId === 'free') {
    const region = raw.region || 'cn';
    baseUrl = region === 'intl' ? FREE_PROXY_URL : FREE_PROXY_URL_CN;
    apiKey = 'free';
    model = 'qwen3.5-flash';
  } else if (providerId === 'qwen') {
    baseUrl = baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    model = model || 'qwen3.5-flash';
  } else if (providerId === 'openai') {
    baseUrl = baseUrl || 'https://api.openai.com/v1';
    model = model || 'gpt-5.3';
  }

  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    // Final fallback preserves the legacy default from ai-service.ts so a
    // custom provider with no model still produces a valid request body.
    model: model || 'gpt-5.3',
    providerId,
  };
}

// ---------------------------------------------------------------------------
// Tool schema mapping
// ---------------------------------------------------------------------------

function toResponsesTools(tools: ToolDef[]): any[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

// ---------------------------------------------------------------------------
// One Responses API call
// ---------------------------------------------------------------------------

export interface ResponsesCallResult {
  /** Parsed output items in canonical Responses API format. */
  outputItems: any[];
  /** Concatenated streamed text (empty if no text deltas were emitted). */
  streamedText: string;
}

export async function callResponses(
  input: ConversationItem[],
  instructions: string,
  tools: ToolDef[],
  config: TransportConfig,
  onTextDelta?: (accumulated: string) => void,
): Promise<ResponsesCallResult> {
  if (!config.apiKey) throw new Error('API key is required');

  const body: Record<string, any> = {
    model: config.model,
    input,
    store: false,
    temperature: 0.7,
    instructions,
  };
  const rTools = toResponsesTools(tools);
  if (rTools) body.tools = rTools;
  if (onTextDelta) body.stream = true;

  const res = await fetch(`${config.baseUrl}/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`API error ${res.status}: ${err}`);
  }

  if (!onTextDelta) {
    const data = await res.json();
    return {
      outputItems: data.output || [],
      streamedText: data.output_text || '',
    };
  }

  return parseSSEStream(res, onTextDelta);
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

async function parseSSEStream(
  res: Response,
  onTextDelta: (accumulated: string) => void,
): Promise<ResponsesCallResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamedText = '';
  let completedOutput: any[] | null = null;

  // Fallback reconstruction (used only if response.completed never arrives)
  const fnCallSlots: Record<number, { call_id: string; name: string; arguments: string }> = {};
  let sawFnCall = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let event: any;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }

      switch (event.type) {
        case 'response.output_text.delta':
          streamedText += event.delta;
          onTextDelta(streamedText);
          break;

        case 'response.output_item.added':
          if (event.item?.type === 'function_call') {
            sawFnCall = true;
            fnCallSlots[event.output_index] = {
              call_id: event.item.call_id || '',
              name: event.item.name || '',
              arguments: '',
            };
          }
          break;

        case 'response.function_call_arguments.delta':
          if (fnCallSlots[event.output_index]) {
            fnCallSlots[event.output_index].arguments += event.delta;
          }
          break;

        case 'response.function_call_arguments.done':
          if (fnCallSlots[event.output_index]) {
            fnCallSlots[event.output_index].arguments = event.arguments;
            if (event.call_id) fnCallSlots[event.output_index].call_id = event.call_id;
            if (event.name) fnCallSlots[event.output_index].name = event.name;
          }
          break;

        case 'response.completed':
          completedOutput = event.response?.output || null;
          break;
      }
    }
  }

  if (completedOutput) {
    return { outputItems: completedOutput, streamedText };
  }

  // Reconstruct from accumulated deltas
  const reconstructed: any[] = [];
  if (sawFnCall) {
    for (const fc of Object.values(fnCallSlots)) {
      reconstructed.push({
        type: 'function_call',
        call_id: fc.call_id,
        name: fc.name,
        arguments: fc.arguments,
        status: 'completed',
      });
    }
  }
  if (streamedText) {
    reconstructed.push({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: streamedText }],
    });
  }
  return { outputItems: reconstructed, streamedText };
}
