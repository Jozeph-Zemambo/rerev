import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LINES, isLineId, MAX_KM_LINE, MAX_LAP_LINE, ENCOURAGEMENT, PUSH, COIN_QUIPS, RUN_STARTS, IDLE_WAIT, IDLE_BREAK } from '../src/voice/lines';
import { ACTION_LINES, ACTIONS, DECISION_LINE_IDS, decisionSchema, parseDecision, sanitiseDecision } from '../src/voice/decisions';

test('line ids are unique and safe as file names', () => {
  const ids = LINES.map(line => line.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]*$/, id);
  for (const line of LINES) assert.ok(line.text.trim().length > 0, line.id);
});

test('splits and laps have a numbered line each, plus a generic one', () => {
  for (let km = 1; km <= MAX_KM_LINE; km++) assert.ok(isLineId(`split_km_${km}`), `km ${km}`);
  for (let lap = 1; lap <= MAX_LAP_LINE; lap++) assert.ok(isLineId(`lap_${lap}`), `lap ${lap}`);
  assert.ok(isLineId('split_km_more'));
  assert.ok(isLineId('lap_more'));
});

test('every line id written in the code is in the catalog', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith('.ts')) files.push(path);
    }
  };
  walk('src');
  walk('convex');
  const prefixes = /^(coach|turn|split|route|lap|hazard|run|coin|cmd|chat|confirm|idle)_[a-z0-9_]+$/;
  let checked = 0;
  for (const file of files) {
    if (file.includes('_generated')) continue;
    for (const [, literal] of readFileSync(file, 'utf8').matchAll(/'([a-z][a-z0-9_]*)'/g)) {
      // Action names (confirm_yes) share the look of line ids.
      if (!prefixes.test(literal) || (ACTIONS as readonly string[]).includes(literal)) continue;
      checked++;
      assert.ok(isLineId(literal), `${file} mentions '${literal}', which isn't a line`);
    }
  }
  assert.ok(checked > 50, `only found ${checked} line ids in the code`);
});

test('line groups said in rotation only hold real lines', () => {
  for (const group of [ENCOURAGEMENT, PUSH, COIN_QUIPS, RUN_STARTS, IDLE_WAIT, IDLE_BREAK]) {
    assert.ok(group.length > 1);
    for (const id of group) assert.ok(isLineId(id), id);
  }
});

test('every action offers at least one real line, and the schema allows exactly those', () => {
  const schema = decisionSchema();
  const branches = schema.properties.decision.anyOf;
  assert.equal(branches.length, ACTIONS.length);
  for (const [i, action] of ACTIONS.entries()) {
    assert.ok(ACTION_LINES[action].length > 0, action);
    for (const id of ACTION_LINES[action]) assert.ok(isLineId(id), `${action}: ${id}`);
    assert.equal(branches[i].properties.action.const, action);
    assert.deepEqual(branches[i].properties.lineId.enum, [...ACTION_LINES[action]]);
  }
  assert.equal(new Set(DECISION_LINE_IDS).size, DECISION_LINE_IDS.length);
});

test('decisions are made safe before the phone acts on them', () => {
  assert.deepEqual(sanitiseDecision({ action: 'ask_break', lineId: 'confirm_ask_break_tired' }, null), { action: 'ask_break', lineId: 'confirm_ask_break_tired' });
  // A line from another action falls back to the action's default line.
  assert.deepEqual(sanitiseDecision({ action: 'break', lineId: 'cmd_go' }, null), { action: 'break', lineId: 'cmd_break' });
  // Yes/no with no question asked is just an acknowledgement.
  assert.deepEqual(sanitiseDecision({ action: 'confirm_yes', lineId: 'confirm_yes_break' }, null), { action: 'none', lineId: 'chat_ack' });
  assert.deepEqual(sanitiseDecision({ action: 'confirm_yes', lineId: 'confirm_yes_break' }, 'break'), { action: 'confirm_yes', lineId: 'confirm_yes_break' });
  assert.deepEqual(sanitiseDecision({ action: 'dance', lineId: 'x' }, null), { action: 'none', lineId: 'chat_ack' });
});

test("Claude's structured output is read, and junk is rejected", () => {
  assert.deepEqual(parseDecision('{"decision":{"action":"status","lineId":"cmd_status"}}', null), { action: 'status', lineId: 'cmd_status' });
  assert.equal(parseDecision('not json', null), null);
  assert.equal(parseDecision('{"action":"status"}', null), null);
});
