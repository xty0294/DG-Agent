/**
 * policies.ts — Hard constraints and runtime guards for the agent loop.
 *
 * This module is the single source of truth for every code-level rule that
 * the LLM cannot bypass. It is intentionally pure: zero side effects, zero
 * imports from other agent modules. The runner consults policies at three
 * checkpoints (per-call cap, per-tool cap, post-response hallucination check)
 * and `tools.ts` consults `clampLimit` when the model tries to widen the
 * device-side strength cap.
 */

import { getMaxStrength } from './providers';

// ---------------------------------------------------------------------------
// Per-turn caps
// ---------------------------------------------------------------------------

/** Hard ceiling on tool-loop iterations within a single user turn. */
export const MAX_TOOL_ITERATIONS = 8;

/** Hard ceiling on total tool calls (any tool) within a single user turn. */
export const MAX_TOOL_CALLS_PER_TURN = 8;

/** Hard ceiling on add_strength calls within a single user turn. */
export const MAX_ADD_STRENGTH_PER_TURN = 2;

/** A turn may correct hallucination at most this many times. */
export const MAX_HALLUCINATION_CORRECTIONS_PER_TURN = 1;

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------

/** Tools that mutate device output (i.e. actually do something physical). */
const MUTATING_TOOLS = new Set<string>([
  'play',
  'stop',
  'add_strength',
  'design_wave',
  'set_strength_limit',
]);

export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

// ---------------------------------------------------------------------------
// Strength-limit clamp (defense-in-depth for set_strength_limit)
// ---------------------------------------------------------------------------

/**
 * Clamp the limit values the LLM passes to `set_strength_limit` so they
 * never exceed the user's app-level safety cap. The user's setting is the
 * absolute ceiling — even if the model raises the device-side limit, it
 * cannot rise above what the user explicitly allowed.
 */
export function clampStrengthLimit(
  requestedA: number,
  requestedB: number,
): { a: number; b: number; clamped: boolean } {
  const maxA = getMaxStrength('A');
  const maxB = getMaxStrength('B');
  const a = Math.min(Math.max(0, requestedA), maxA);
  const b = Math.min(Math.max(0, requestedB), maxB);
  return { a, b, clamped: a !== requestedA || b !== requestedB };
}

// ---------------------------------------------------------------------------
// Hallucination guard
// ---------------------------------------------------------------------------

/**
 * Phrases that claim a *device action* was completed (e.g. "已经把强度加到 20").
 * If matched and no MUTATING tool was called this turn, the reply is a
 * fabricated action and gets discarded + corrected.
 */
const ACTION_CLAIM_PATTERNS: RegExp[] = [
  // (已/已经/帮你/为你/给你) + optional (把/将) + 0–12 chinese chars + action verb
  /(已经?|帮你|为你|给你)[\u4e00-\u9fff、，,\s]{0,12}?(增加|加大|加强|提高|提升|调高|拉高|升到|升至|加到|降低|减小|减弱|调低|降到|降至|减到|开启|启动|打开|开始|停止|关闭|关掉|切换|换成|换为|换到|切到|设为|设成|设置|调成|调到|调整到)/,
  // 把/将 + (强度/波形/输出/刺激) + ... + result-state verb
  /[把将](?:强度|波形|输出|刺激)[\u4e00-\u9fff0-9、，,\s]{0,20}?(加到|调到|升到|降到|设到|设为|换成|换为|切到|提到|加大到|减小到)/,
];

/**
 * Phrases that claim *current device state* without ever having checked it
 * (e.g. "现在 A 通道强度是 8"). If matched and NO tool of any kind was
 * called this turn (including get_status), the model is fabricating state.
 */
const STATE_CLAIM_PATTERNS: RegExp[] = [
  /(现在|目前|当前)\s*(?:的)?\s*(?:[AB]\s*通道)?\s*(?:强度|波形)\s*(?:已|是|为)/,
];

export type HallucinationKind = 'action' | 'state';

export interface HallucinationVerdict {
  kind: HallucinationKind;
  matched: string;
}

/**
 * Inspect a finalized assistant text against the runner's tool-usage state.
 * Returns the kind of hallucination detected, or null if the text is clean.
 *
 * Two-tier detection:
 *   - Action claim → only fires when no mutating tool ran
 *   - State claim  → only fires when no tool of any kind ran
 *
 * This avoids false positives like "现在强度是 8" right after a get_status.
 */
export function detectHallucination(
  text: string,
  state: { mutatingToolCalled: boolean; anyToolCalled: boolean },
): HallucinationVerdict | null {
  if (!text) return null;

  if (!state.mutatingToolCalled) {
    for (const re of ACTION_CLAIM_PATTERNS) {
      const m = text.match(re);
      if (m) return { kind: 'action', matched: m[0] };
    }
  }

  if (!state.anyToolCalled) {
    for (const re of STATE_CLAIM_PATTERNS) {
      const m = text.match(re);
      if (m) return { kind: 'state', matched: m[0] };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Correction note (injected as a synthetic user message after a discard)
// ---------------------------------------------------------------------------

export function buildHallucinationCorrectionNote(kind: HallucinationKind): string {
  if (kind === 'action') {
    return (
      '[系统纠正 — 用户不可见]\n' +
      '你刚才的回复中出现了"已经/帮你/为你 + 增加/降低/打开/切换/调到..."等表示"已完成设备操作"的措辞，但本回合你并没有实际调用任何设备控制工具（play / stop / add_strength / design_wave / set_strength_limit）。这是被禁止的幻觉行为——说了不等于做了。\n' +
      '请按下面两种方式之一重写本次回复：\n' +
      '  1. 如果你确实想执行该操作 → 现在调用对应的工具，再用一句话告诉用户结果\n' +
      '  2. 如果你只想表达建议 → 重写回复去掉所有"已经/帮你..."这类完成态措辞，改用"我可以帮你..."、"要不要..."等未完成态\n' +
      '不要为这次纠正向用户道歉，也不要在回复里提到本系统消息。'
    );
  }
  return (
    '[系统纠正 — 用户不可见]\n' +
    '你刚才的回复中声称了"现在/目前 强度/波形 是 X"这类具体的设备状态值，但本回合你并没有调用 get_status 或任何工具来确认。请不要凭记忆或猜测描述设备状态。\n' +
    '请重写本次回复：先调用 get_status 拿到真实状态，再据此回复用户；或者重写措辞，避免提及任何具体的当前数值。\n' +
    '不要为这次纠正向用户道歉，也不要在回复里提到本系统消息。'
  );
}
