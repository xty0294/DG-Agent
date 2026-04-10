/**
 * permission-dialog.ts — Modal dialog that asks the user to approve or
 * deny an AI-initiated tool call. Resolves with the user's chosen scope
 * (once / timed / always / deny).
 *
 * Only one dialog is live at a time. If the user aborts the in-flight
 * turn while a dialog is open, call `closeActiveDialog()` to resolve it
 * as 'deny' and let the abort propagate normally.
 */

import type { PermissionChoice } from '../agent/permissions';

interface ActiveDialog {
  backdrop: HTMLDivElement;
  resolve: (choice: PermissionChoice) => void;
  keyHandler: (e: KeyboardEvent) => void;
}

let active: ActiveDialog | null = null;

/** Show a permission dialog for `toolName(args)` and await the user. */
export function askPermission(
  toolName: string,
  args: Record<string, unknown>,
): Promise<PermissionChoice> {
  // If a dialog is somehow still open (shouldn't happen — tool calls are
  // sequential), close the old one as a denial before opening a new one.
  if (active) closeActiveDialog();

  return new Promise<PermissionChoice>((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'permission-modal-backdrop';

    const modal = document.createElement('div');
    modal.className = 'permission-modal';

    const title = document.createElement('div');
    title.className = 'permission-title';
    title.textContent = 'AI 请求调用工具';

    const subtitle = document.createElement('div');
    subtitle.className = 'permission-subtitle';
    subtitle.textContent = '请确认是否允许本次设备操作';

    const toolRow = document.createElement('div');
    toolRow.className = 'permission-tool-row';
    const toolLabel = document.createElement('span');
    toolLabel.className = 'permission-tool-label';
    toolLabel.textContent = '工具';
    const toolName_ = document.createElement('span');
    toolName_.className = 'permission-tool-name';
    toolName_.textContent = toolName;
    toolRow.appendChild(toolLabel);
    toolRow.appendChild(toolName_);

    // Primary: human-readable description of what the AI wants to do.
    const descLabel = document.createElement('div');
    descLabel.className = 'permission-args-label';
    descLabel.textContent = '操作说明';

    const descEl = document.createElement('div');
    descEl.className = 'permission-description';
    descEl.textContent = describeToolCall(toolName, args);

    // Secondary: raw JSON, collapsed by default for users who want to verify.
    const rawDetails = document.createElement('details');
    rawDetails.className = 'permission-raw-details';
    const rawSummary = document.createElement('summary');
    rawSummary.textContent = '查看原始参数';
    const rawEl = document.createElement('pre');
    rawEl.className = 'permission-args';
    rawEl.textContent = formatArgs(args);
    rawDetails.appendChild(rawSummary);
    rawDetails.appendChild(rawEl);

    const buttons = document.createElement('div');
    buttons.className = 'permission-buttons';

    const pick = (choice: PermissionChoice) => {
      closeActiveDialog();
      resolve(choice);
    };

    buttons.appendChild(makeBtn('拒绝', 'deny', () => pick('deny')));
    buttons.appendChild(makeBtn('允许本次', 'once', () => pick('once')));
    buttons.appendChild(makeBtn('5 分钟内都允许', 'timed', () => pick('timed')));
    buttons.appendChild(makeBtn('总是允许（本会话）', 'always', () => pick('always')));

    modal.appendChild(title);
    modal.appendChild(subtitle);
    modal.appendChild(toolRow);
    modal.appendChild(descLabel);
    modal.appendChild(descEl);
    modal.appendChild(rawDetails);
    modal.appendChild(buttons);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') pick('deny');
    };
    document.addEventListener('keydown', keyHandler);

    active = { backdrop, resolve, keyHandler };
  });
}

/**
 * Close any currently open permission dialog and resolve it as 'deny'.
 * Safe to call if nothing is open. Called on user-initiated abort.
 */
export function closeActiveDialog(): void {
  if (!active) return;
  const { backdrop, resolve, keyHandler } = active;
  active = null;
  document.removeEventListener('keydown', keyHandler);
  backdrop.remove();
  // Resolving AFTER nulling `active` so the caller can reopen a new dialog
  // from inside the resolve handler without tripping the "already open" guard.
  resolve('deny');
}

/** True if a dialog is currently waiting for the user. */
export function hasActiveDialog(): boolean {
  return active !== null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBtn(
  label: string,
  cls: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = `permission-btn permission-btn-${cls}`;
  btn.textContent = label;
  btn.addEventListener('click', onClick);
  return btn;
}

function formatArgs(args: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return '(无参数)';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

// ---------------------------------------------------------------------------
// Human-readable tool-call descriptions
// ---------------------------------------------------------------------------

const WAVE_LABELS: Record<string, string> = {
  breath: '呼吸（最柔）',
  tide: '潮汐',
  pulse_low: '低脉冲',
  pulse_mid: '中脉冲',
  pulse_high: '高脉冲',
  tap: '敲击',
};

function chLabel(ch: unknown): string {
  const c = typeof ch === 'string' ? ch.toUpperCase() : '';
  return c === 'A' || c === 'B' ? `${c} 通道` : '';
}

function waveLabel(preset: unknown): string {
  if (typeof preset !== 'string') return '';
  return WAVE_LABELS[preset] || preset;
}

/**
 * Render a (toolName, args) pair as a single human-readable sentence.
 * Falls back to a generic "调用 <name>" line for unknown tools.
 */
function describeToolCall(name: string, args: Record<string, unknown>): string {
  const ch = chLabel(args.channel);

  switch (name) {
    case 'play': {
      const strength = args.strength;
      const preset = args.preset;
      const frequency = args.frequency;
      const intensity = args.intensity;

      if (preset) {
        return `在 ${ch || '通道'} 播放「${waveLabel(preset)}」波形，强度调至 ${strength}`;
      }
      if (frequency != null && intensity != null) {
        return `在 ${ch || '通道'} 播放自定义频率波形（频率 ${frequency}ms / 能量 ${intensity}%），强度调至 ${strength}`;
      }
      return `在 ${ch || '通道'} 播放波形，强度调至 ${strength}`;
    }

    case 'stop': {
      if (ch) return `停止 ${ch}：强度归零并关闭波形输出`;
      return '停止所有通道：A 与 B 同时归零并关闭波形';
    }

    case 'add_strength': {
      const delta = Number(args.delta);
      if (!Number.isFinite(delta) || delta === 0) {
        return `${ch || '通道'} 强度微调`;
      }
      const sign = delta > 0 ? '+' : '';
      const verb = delta > 0 ? '增加' : '降低';
      return `${ch || '通道'} 强度${verb} ${sign}${delta}（在当前波形上微调）`;
    }

    case 'design_wave': {
      const strength = args.strength;
      const steps = args.steps;
      const stepCount = Array.isArray(steps) ? steps.length : 0;
      return `在 ${ch || '通道'} 播放自定义多步波形（${stepCount} 步），强度调至 ${strength}`;
    }

    case 'set_strength_limit': {
      const a = args.limit_a;
      const b = args.limit_b;
      return `设置设备侧强度上限：A 通道 ≤ ${a}，B 通道 ≤ ${b}`;
    }

    case 'get_status':
      return '读取设备当前状态（只读）';

    default:
      return `调用工具「${name}」`;
  }
}
