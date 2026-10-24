import { lineById, type LineId } from './lines';

/**
 * What the buddy can decide to do when the runner says something the keyword rules don't
 * cover. Claude (via Convex) picks one action plus one of the lines allowed for it; the app
 * then does the action and plays the line. Shared by the client and `convex/buddy.ts`.
 */
export const ACTIONS = ['none', 'ask_break', 'break', 'go', 'faster', 'slower', 'status', 'finish', 'confirm_yes', 'confirm_no'] as const;
export type Action = (typeof ACTIONS)[number];

/** The lines that fit each action. The first is the default. */
export const ACTION_LINES = {
  none: ['chat_ack', 'chat_encourage', 'chat_tough', 'chat_thanks', 'chat_laugh'],
  ask_break: ['confirm_ask_break', 'confirm_ask_break_tired', 'coach_breather_ask'],
  break: ['cmd_break', 'cmd_break_unwell'],
  go: ['cmd_go', 'cmd_go_cheer'],
  faster: ['cmd_faster', 'cmd_faster_2'],
  slower: ['cmd_slower', 'cmd_slower_2'],
  status: ['cmd_status'],
  finish: ['cmd_finish'],
  confirm_yes: ['confirm_yes_break'],
  confirm_no: ['confirm_no'],
} as const satisfies Record<Action, readonly LineId[]>;

export type DecisionLineId = (typeof ACTION_LINES)[Action][number];
export type Decision = { action: Action; lineId: DecisionLineId };

export const DECISION_LINE_IDS: readonly DecisionLineId[] = [...new Set(ACTIONS.flatMap(action => ACTION_LINES[action] as readonly DecisionLineId[]))];

/** The one question the buddy can be waiting on an answer to. */
export type PendingKind = 'break';

/**
 * Make a decision safe to act on: a line that doesn't belong to its action becomes the
 * action's default line, and yes/no with nothing asked becomes a plain acknowledgement.
 */
export function sanitiseDecision(decision: { action: string; lineId: string }, pending: PendingKind | null): Decision {
  const action = (ACTIONS as readonly string[]).includes(decision.action) ? (decision.action as Action) : 'none';
  if ((action === 'confirm_yes' || action === 'confirm_no') && !pending) return { action: 'none', lineId: 'chat_ack' };
  const allowed = ACTION_LINES[action] as readonly DecisionLineId[];
  const lineId = allowed.find(id => id === decision.lineId) ?? allowed[0];
  return { action, lineId };
}

/**
 * JSON schema for Claude's structured output: one branch per action, each allowing only that
 * action's lines, so an action can't come back paired with a line that doesn't fit it.
 * Written by hand because the SDK's zod helper strips `enum`/`const` to descriptions, which
 * would leave the ids unenforced. The union sits under one property so the root stays a plain
 * object. Output looks like `{"decision":{"action":"ask_break","lineId":"confirm_ask_break"}}`.
 */
export function decisionSchema() {
  return {
    type: 'object',
    properties: {
      decision: {
        anyOf: ACTIONS.map(action => ({
          type: 'object',
          properties: {
            action: { type: 'string', const: action },
            lineId: { type: 'string', enum: [...ACTION_LINES[action]] },
          },
          required: ['action', 'lineId'],
          additionalProperties: false,
        })),
      },
    },
    required: ['decision'],
    additionalProperties: false,
  };
}

/** Read Claude's structured output; null if it isn't a decision at all. */
export function parseDecision(json: string, pending: PendingKind | null): Decision | null {
  try {
    const decision = (JSON.parse(json) as { decision?: { action?: unknown; lineId?: unknown } }).decision;
    if (typeof decision?.action !== 'string' || typeof decision.lineId !== 'string') return null;
    return sanitiseDecision({ action: decision.action, lineId: decision.lineId }, pending);
  } catch {
    return null;
  }
}

/** The menu for Claude: each action with its lines' ids and words, one line per action. */
export function decisionMenu() {
  return ACTIONS.map(action => `${action}: ${(ACTION_LINES[action] as readonly LineId[]).map(id => `${id} "${lineById(id).text}"`).join(' | ')}`).join('\n');
}
