/**
 * agent/index.ts — Public API for the agent module.
 */

export * as bluetooth from './bluetooth';
export * as history from './history';
export * as conversation from './conversation';
export { PROMPT_PRESETS, DEFAULT_PRESET_ID, buildInstructions } from './prompts';
export { tools, executeTool } from './tools';
export { PROVIDERS, loadSettings, saveSettings } from './providers';
