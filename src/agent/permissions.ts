/**
 * permissions.ts — Per-tool permission store for AI-initiated tool calls.
 *
 * Every mutating tool call has to pass a permission gate before it reaches
 * the executor. The gate asks the user (via a UI callback) the first time a
 * tool is invoked and remembers the decision for subsequent calls according
 * to the user's chosen scope:
 *
 *   - once   : allow this single call, ask again next time
 *   - timed  : auto-allow this tool for the next 5 minutes
 *   - always : auto-allow this tool for the rest of the current session
 *   - deny   : reject this single call, ask again next time
 *
 * Grants are stored in memory only and wiped on page reload — on purpose.
 * Persisting "always allow" for device-control tools across sessions would
 * defeat the point of having a gate at all for a physical device.
 */

import { isMutatingTool } from './policies';

export type PermissionChoice = 'once' | 'timed' | 'always' | 'deny';

/** Window used by the 'timed' scope. */
const TIMED_GRANT_MS = 5 * 60 * 1000;

interface Grant {
  /** Expiry epoch millis; Number.POSITIVE_INFINITY means session-wide. */
  until: number;
}

const grants = new Map<string, Grant>();

/** True if the given tool name needs to pass the permission gate at all. */
export function requiresPermission(toolName: string): boolean {
  return isMutatingTool(toolName);
}

/** True if a live grant already exists for this tool (and has not expired). */
export function hasGrant(toolName: string): boolean {
  const g = grants.get(toolName);
  if (!g) return false;
  if (Date.now() > g.until) {
    grants.delete(toolName);
    return false;
  }
  return true;
}

/**
 * Apply the user's choice to the grant store.
 * Returns the effective decision ('allow' or 'deny') that the caller should
 * act on for the current call.
 */
export function recordChoice(
  toolName: string,
  choice: PermissionChoice,
): 'allow' | 'deny' {
  if (choice === 'deny') return 'deny';
  if (choice === 'timed') {
    grants.set(toolName, { until: Date.now() + TIMED_GRANT_MS });
  } else if (choice === 'always') {
    grants.set(toolName, { until: Number.POSITIVE_INFINITY });
  }
  // 'once' leaves no grant behind — next call will prompt again.
  return 'allow';
}

/** Wipe every grant. Useful for tests and for a future "reset permissions" UI. */
export function clearGrants(): void {
  grants.clear();
}
