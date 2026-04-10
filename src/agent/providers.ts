/**
 * agent/providers.ts — Provider definitions and settings persistence.
 * Pure data layer, no DOM dependency.
 */

import type { ProviderDef, AppSettings } from '../types';

const SETTINGS_STORAGE_KEY = 'dg-agent-settings';

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'free',
    name: '免费体验',
    hint: '无需 API Key，每分钟限 10 条',
    fields: [],
  },
  {
    id: 'qwen',
    name: '通义千问',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'qwen3.6-plus' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'gpt-5.3' },
      { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://api.openai.com/v1' },
    ],
  },
  {
    id: 'custom',
    name: '自定义',
    hint: '自定义模型、API Key 和接口地址',
    fields: [
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'sk-...' },
      { key: 'model', label: '模型', type: 'text', placeholder: 'model-name' },
      { key: 'baseUrl', label: 'Base URL', type: 'url', placeholder: 'https://api.example.com/v1' },
    ],
  },
];

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as AppSettings;
  } catch (_) { /* */ }
  return { provider: 'free', configs: {}, presetId: 'gentle', customPrompt: '', backgroundBehavior: 'stop' };
}

export function saveSettings(settings: AppSettings): void {
  try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings)); } catch (_) { /* */ }
}
