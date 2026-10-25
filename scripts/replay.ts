/**
 * Replay a field recording through the app's own surface map, path and buddy, and print what
 * happened and why: buddy state changes, blocks and detours, per-second depth verdicts and
 * heights, distrusted / stale frames, re-based cells, with the moments around each Mark in
 * detail, and how closely the replay matches what the phone logged.
 *
 *   npm run replay                              list recent sessions
 *   npm run replay -- <session> [options]       replay one (any unique part of its name)
 *
 * Options:
 *   --run N               only segment N (runs and course recordings, as numbered in the output)
 *   --tune k=v[,k=v]      override SurfaceMap thresholds, e.g. --tune obstacleMin=0.2,dropFrames=6
 *   --walkable-step M     override the walkable step logged at run start
 *   --pace M/S            buddy pace on a map route (not logged; default 1.6)
 *   --logged-depth-only   feed only the logged depth frames (5x a second). By default each is
 *                         also fed a tick earlier, standing in for the unlogged one in between
 *   --no-breaks           don't put the buddy on a break when the phone's log says it was
 *   --follow              lay Quick start runs following the runner (from the recorded camera
 *                         track), even ones the phone laid as a fixed straight path
 *   --fixed               lay Quick start runs as the fixed straight path, even follow-me ones
 *   --window S            seconds of detail before and after each mark (default 3)
 *   --dump-mark N         write mark N's frames as a point cloud CSV (repeatable)
 *   --dump-marks          ... for every mark
 *   --events-only         skip the per-second lines (marks still get their detail)
 *   --refresh             fetch the session again even if it's cached
 *   --offline             only use cached sessions
 *
 * Sessions are fetched with `npx convex run fieldLog:bySession` (an internal query, read only)
 * and cached in field-recordings/ so re-runs work offline. Needs CONVEX_DEPLOYMENT (or a
 * .env.local) for the first fetch.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AHEAD,
  agreement,
  BAND_NAMES,
  CLEAR_BODY,
  cm,
  fetchAllRows,
  median,
  replaySession,
  type FrameReport,
  type OffsetStats,
  type ReplayEvent,
  type ReplayOptions,
  type Row,
  type Segment,
} from '../src/debug/replay';
import { DEFAULT_TUNING, type SurfaceTuning } from '../src/world/surfaceMap';

const CACHE = 'field-recordings';

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const flags = new Set<string>();
const values = new Map<string, string[]>();
const positional: string[] = [];
const WITH_VALUE = new Set(['--run', '--tune', '--walkable-step', '--pace', '--window', '--dump-mark']);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (WITH_VALUE.has(arg)) {
    if (i + 1 >= argv.length) fail(`${arg} needs a value`);
    values.set(arg, [...(values.get(arg) ?? []), argv[++i]]);
  } else if (arg.startsWith('--')) flags.add(arg);
  else positional.push(arg);
}
const KNOWN_FLAGS = ['--follow', '--fixed', '--logged-depth-only', '--no-breaks', '--dump-marks', '--events-only', '--refresh', '--offline', '--help'];
for (const flag of flags) if (!KNOWN_FLAGS.includes(flag)) fail(`Unknown option ${flag}`);
if (flags.has('--help')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?|^ \* ?/gm, ''));
  process.exit(0);
}

const number = (name: string): number | undefined => {
  const raw = values.get(name)?.at(-1);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) fail(`${name} needs a number, got "${raw}"`);
  return n;
};

function parseTuning(): Partial<SurfaceTuning> {
  const tuning: Partial<SurfaceTuning> = {};
  for (const pair of (values.get('--tune') ?? []).flatMap(v => v.split(','))) {
    const [key, raw] = pair.split('=');
    if (!(key in DEFAULT_TUNING)) fail(`Unknown threshold "${key}". Known: ${Object.keys(DEFAULT_TUNING).join(', ')}`);
    const n = Number(raw);
    if (!Number.isFinite(n)) fail(`--tune ${key} needs a number`);
    tuning[key as keyof SurfaceTuning] = n;
  }
  return tuning;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---------------------------------------------------------------- fetching and caching

function convex(fn: string, args: Record<string, unknown>): unknown {
  const result = spawnSync('npx', ['convex', 'run', fn, JSON.stringify(args)], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (result.error) fail(`Couldn't run npx convex: ${result.error.message}`);
  if (result.status !== 0) fail(`npx convex run ${fn} failed:\n${result.stderr || result.stdout}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`Unexpected output from npx convex run ${fn}:\n${result.stdout.slice(0, 500)}`);
  }
}

const cacheFile = (session: string) => join(CACHE, `${session.replace(/[^\w.-]/g, '-')}.json`);

function cachedSessions(): string[] {
  if (!existsSync(CACHE)) return [];
  return readdirSync(CACHE)
    .filter(f => f.endsWith('.json'))
    .flatMap(f => {
      try {
        return [(JSON.parse(readFileSync(join(CACHE, f), 'utf8')) as { session: string }).session];
      } catch {
        return [];
      }
    });
}

function remoteSessions(): { session: string; entries: number }[] {
  return convex('fieldLog:sessions', {}) as { session: string; entries: number }[];
}

function loadSession(session: string): Row[] {
  const file = cacheFile(session);
  if (existsSync(file) && !flags.has('--refresh')) return (JSON.parse(readFileSync(file, 'utf8')) as { rows: Row[] }).rows;
  if (flags.has('--offline')) fail(`${session} isn't cached (${file}).`);
  process.stderr.write(`Fetching ${session}`);
  const rows = fetchAllRows((after, limit) => {
    process.stderr.write('.');
    return convex('fieldLog:bySession', { session, limit, ...(after === undefined ? {} : { after }) }) as Row[];
  });
  process.stderr.write(` ${rows.length} rows\n`);
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, JSON.stringify({ session, fetchedAt: new Date().toISOString(), rows }));
  return rows;
}

function resolveSession(query: string): string {
  const cached = cachedSessions();
  if (cached.includes(query)) return query;
  const candidates = new Set(cached.filter(s => s.includes(query)));
  if (candidates.size !== 1 && !flags.has('--offline')) {
    const remote = remoteSessions().map(s => s.session);
    if (remote.includes(query)) return query;
    for (const s of remote) if (s.includes(query)) candidates.add(s);
  }
  if (candidates.size === 1) return [...candidates][0];
  if (candidates.size > 1) fail(`"${query}" matches several sessions: ${[...candidates].join(', ')}`);
  // Not listed (the listing only covers recent rows): try it as a full session name.
  return query;
}

function listSessions() {
  const cached = new Set(cachedSessions());
  console.log('Field-test sessions (newest first; entry counts cover recent rows only):\n');
  if (!flags.has('--offline')) {
    for (const { session, entries } of remoteSessions()) {
      console.log(`  ${session}  ${String(entries).padStart(6)} entries${cached.has(session) ? '  (cached)' : ''}`);
      cached.delete(session);
    }
  }
  for (const session of cached) console.log(`  ${session}  (cached only)`);
  console.log('\nnpm run replay -- <session or any unique part of it> [options]   (--help for options)');
}

// ---------------------------------------------------------------- printing

const f1 = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toFixed(1));
const f2 = (n: number | null | undefined) => (n === null || n === undefined ? '–' : n.toFixed(2));
const time = (t: number) => `${t.toFixed(2).padStart(7)}s`;
const pct = (n: number, of: number) => (of === 0 ? '–' : `${Math.round((100 * n) / of)}%`);

/** Verdict shares and median height per distance band, over some frames. */
function bandSummary(frames: FrameReport[]): string {
  return BAND_NAMES.map((name, i) => {
    const bands = frames.map(f => f.bands[i]);
    const sum = (key: 'ground' | 'obstacle' | 'drop' | 'between' | 'noGround') => bands.reduce((n, b) => n + b[key], 0);
    const judged = sum('ground') + sum('obstacle') + sum('drop') + sum('between');
    if (judged === 0) return `${name} ${sum('noGround') ? `${sum('noGround')} pts, no ground` : '–'}`;
    const heights = bands.flatMap(b => b.heights);
    return `${name} g${pct(sum('ground'), judged)} d${pct(sum('drop'), judged)} o${pct(sum('obstacle'), judged)} (${judged}) mid ${cm(median(heights))}`;
  }).join(' | ');
}

function ratioSummary(frames: FrameReport[]): string {
  const ratios = BAND_NAMES.map((_, i) => median(frames.flatMap(f => f.bands[i].ratios)));
  return ratios.some(r => r !== null) ? `ratio ${ratios.map(r => (r === null ? '–' : `×${r.toFixed(2)}`)).join(' ')}` : 'ratio –';
}

function hitsSummary(frames: FrameReport[]): string {
  const accepted = frames.reduce((n, f) => n + f.hits.accepted, 0);
  const rejected = frames.reduce((n, f) => n + f.hits.rejected, 0);
  const unknown = frames.reduce((n, f) => n + f.hits.unknown, 0);
  return `hits ${accepted}/${accepted + rejected}${unknown ? ` +${unknown}?` : ''}`;
}

function flagsSummary(frames: FrameReport[]): string {
  const parts: string[] = [];
  const count = (pick: (f: FrameReport) => boolean) => frames.filter(pick).length;
  if (count(f => f.stale)) parts.push(`stale ${count(f => f.stale)}`);
  if (count(f => f.repeated)) parts.push(`no-depth ${count(f => f.repeated)}`);
  if (count(f => f.distrusted)) parts.push(`distrusted ${count(f => f.distrusted)}`);
  const rebased = frames.reduce((n, f) => n + f.rebased, 0);
  if (rebased) parts.push(`rebased ${rebased}`);
  return parts.join(' ');
}

function buddySummary(frame: FrameReport): string {
  if (frame.runnerS === null) return 'recording';
  const block = frame.blockedAtS === null ? '' : ` BLOCK ${frame.blockReason}@${f1(frame.blockedAtS)}`;
  const lead = frame.buddyS! - frame.runnerS;
  return `s ${f1(frame.runnerS)} ${frame.state} ${lead >= 0 ? '+' : ''}${f1(lead)}${frame.detouring ? ' detour' : ''}${block}`;
}

function secondLine(second: number, frames: FrameReport[]): string {
  const last = frames.at(-1)!;
  const extra = flagsSummary(frames);
  return `  [${String(second).padStart(4)}s] ${buddySummary(last)} · ${bandSummary(frames)} · ${ratioSummary(frames)} · ${hitsSummary(frames)}${extra ? ` · ${extra}` : ''}`;
}

function frameLine(frame: FrameReport): string {
  const extra = flagsSummary([frame]);
  return `     ${time(frame.t)} ${buddySummary(frame)} · ${frame.points} pts · ${bandSummary([frame])} · ${ratioSummary([frame])} · ${hitsSummary([frame])}${extra ? ` · ${extra}` : ''}`;
}

function printSegment(segment: Segment, window: number, eventsOnly: boolean) {
  const title = segment.kind === 'run' ? `RUN ${segment.index} (${segment.mode})` : `COURSE RECORDING (before run ${segment.index})`;
  console.log(`\n${'='.repeat(100)}\n${title}  ${segment.startT.toFixed(2)}–${segment.endT.toFixed(2)} s${segment.endReason ? `, ended: ${segment.endReason}` : ''}`);
  for (const note of new Set(segment.notes)) console.log(`  note: ${note}`);

  if (!segment.replayable) return printLogOnly(segment);
  if (segment.frames.length === 0) {
    // Nothing moved the replay, so comparing it with the phone would say nothing.
    console.log('  No raw frames in this segment (depth off, or recorded before frames were logged).');
    return printLogOnly(segment);
  }

  const marks = segment.events.filter(e => e.kind === 'mark');
  const nearMark = (t: number) => marks.some(m => Math.abs(t - m.t) <= window);
  const bySecond = new Map<number, FrameReport[]>();
  for (const frame of segment.frames) {
    const second = Math.floor(frame.t);
    bySecond.set(second, [...(bySecond.get(second) ?? []), frame]);
  }
  // One timeline: events as they happened, a summary line as each second ends, and every frame
  // within the window around a mark.
  type Line = { t: number; order: number; text: string };
  const lines: Line[] = [];
  for (const e of mergeRebases(segment.events)) {
    const s = e.s === null ? '' : ` s ${f1(e.s)}`;
    const text = e.kind === 'mark' ? `\n  *** ${e.text.replace(/^MARK (\S+):/, 'MARK $1 ***')}  (at ${e.t.toFixed(2)} s${s})` : `  ${time(e.t)}${s.padEnd(8)} ${e.text}`;
    lines.push({ t: e.t, order: e.kind === 'mark' ? 0 : 1, text });
  }
  if (!eventsOnly) for (const [second, frames] of bySecond) lines.push({ t: second + 0.999, order: 2, text: secondLine(second, frames) });
  for (const frame of segment.frames) if (nearMark(frame.t)) lines.push({ t: frame.t, order: 3, text: frameLine(frame) });
  lines.sort((a, b) => a.t - b.t || a.order - b.order);
  for (const line of lines) console.log(line.text);

  if (segment.kind === 'run') printPathVsTrack(segment);
  if (segment.kind === 'run') printPacing(segment);
  if (segment.kind === 'run') printBuddyClearance(segment);
  if (segment.kind === 'run') printAgreement(segment);
}

/** How close the buddy came to what the map flagged. */
function printBuddyClearance(segment: Segment) {
  const c = segment.buddyClearance;
  if (!c || c.seconds === 0) return;
  const closest = Number.isFinite(c.closest) ? `${f2(c.closest)} m at ${c.at.toFixed(1)} s (${c.state})` : 'never near one';
  console.log(`\n  Buddy vs flagged cells (its centre to their edge): closest ${closest}; within ${CLEAR_BODY} m for ${c.secondsWithin.toFixed(1)} of ${c.seconds.toFixed(0)} s`);
}

/** How steadily the buddy kept pace: time in each state, state switches, lead while walking. */
function printPacing(segment: Segment) {
  const p = segment.pacing;
  if (!p || p.seconds <= 0) return;
  const states = Object.entries(p.stateSeconds)
    .sort((a, b) => b[1] - a[1])
    .map(([state, seconds]) => `${state} ${pct(seconds, p.seconds)}`)
    .join(', ');
  console.log(`\n  Pacing (${p.seconds.toFixed(0)} s): ${states}; ${p.switches} state switches (${((60 * p.switches) / p.seconds).toFixed(1)}/min); the buddy stopped dead ${p.buddyStops} times`);
  const clips = Object.entries(p.clipSeconds)
    .sort((a, b) => b[1] - a[1])
    .map(([clip, seconds]) => `${clip} ${pct(seconds, p.seconds)}`)
    .join(', ');
  console.log(`    animation: ${clips}; ${p.clipSwitches} clip changes (${((60 * p.clipSwitches) / p.seconds).toFixed(1)}/min)`);
  if (!p.walkingLeads.length) return;
  const q = (values: number[], at: number) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(at * values.length))];
  console.log(
    `    while the runner walked (median ${f2(q(p.walkingSpeeds, 0.5))} m/s): ` +
      `lead median ${f2(q(p.walkingLeads, 0.5))} m, 10–90% ${f2(q(p.walkingLeads, 0.1))}…${f2(q(p.walkingLeads, 0.9))} m`,
  );
}

/** How well the path ahead kept to where the runner actually went. */
function printPathVsTrack(segment: Segment) {
  const result = segment.pathVsTrack;
  if (segment.follow) console.log(`\n  Follow-me: ${segment.follow.bends} bends onto the runner's line, ${segment.follow.respawns} catch-ups after being passed, ${segment.follow.extends} extensions`);
  if (!result || result.all.n === 0) return;
  const stats = (s: OffsetStats) =>
    `median ${f2(s.median)} m, 90% within ${f2(s.p90)} m, worst ${f2(s.max)} m, over 50 cm ${s.n ? Math.round((100 * s.over50) / s.n) : 0}%`;
  console.log(`\n  Path ahead vs where the runner went (${segment.follow ? 'following' : 'fixed path'}; the path's line at +2…+6 m from the runner, against their track from then on):`);
  AHEAD.forEach((d, k) => console.log(`    +${d} m: ${stats(result.byAhead[k])} (${result.byAhead[k].n} samples)`));
  console.log(`    all:  ${stats(result.all)}`);
}

/** Re-based cells usually come in bursts (one floor patch at a time): one line per burst. */
function mergeRebases(events: ReplayEvent[]): ReplayEvent[] {
  const out: ReplayEvent[] = [];
  let burst: ReplayEvent[] = [];
  const flush = () => {
    if (burst.length === 1) out.push(burst[0]);
    else if (burst.length > 1) {
      const xs = burst.map(e => e.data!.x as number);
      const zs = burst.map(e => e.data!.z as number);
      const shifts = burst.map(e => e.data!.shift as number | null).filter((n): n is number => n !== null);
      const range = shifts.length ? ` by ${cm(Math.min(...shifts))}${shifts.length > 1 ? ` to ${cm(Math.max(...shifts))}` : ''}` : '';
      const span = `x ${f1(Math.min(...xs))}…${f1(Math.max(...xs))} z ${f1(Math.min(...zs))}…${f1(Math.max(...zs))}`;
      out.push({ ...burst[0], text: `floor detection re-based ${burst.length} cells (${span})${range}, over ${(burst.at(-1)!.t - burst[0].t).toFixed(1)} s` });
    }
    burst = [];
  };
  for (const e of events) {
    if (e.kind !== 'rebase') {
      flush();
      out.push(e);
    } else {
      if (burst.length && e.t - burst.at(-1)!.t > 1) flush();
      burst.push(e);
    }
  }
  flush();
  return out;
}

function printLogOnly(segment: Segment) {
  console.log("  What the phone logged (its own view; nothing replayed):");
  let last = '';
  for (const tick of segment.recordedTicks) {
    const d = tick.data ?? {};
    const block = d.path?.blockedAtS == null ? '' : ` BLOCK ${d.path.reason}@${f1(d.path.blockedAtS)}`;
    const now = `${d.state}${block}${d.path?.detouring ? ' detour' : ''}`;
    if (now === last) continue;
    last = now;
    const hazards = d.hazardCounts ? ` · hazards o${d.hazardCounts.obstacle} d${d.hazardCounts.drop}` : '';
    const lead = (d.buddyS ?? 0) - (d.runnerS ?? 0);
    console.log(`  ${time(tick.t)} s ${f1(d.runnerS)} buddy ${now} (${lead >= 0 ? '+' : ''}${f1(lead)})${hazards}`);
  }
  for (const mark of segment.marks) console.log(`  *** MARK ${mark.data?.n} *** at ${mark.t.toFixed(2)} s: ${JSON.stringify(mark.data)}`);
}

function printAgreement(segment: Segment) {
  const a = agreement(segment.ticks);
  console.log(`\n  Replay vs phone (${a.ticks} ticks):`);
  if (a.ticks === 0) return console.log('    no ticks to compare');
  console.log(`    buddy state agrees ${pct(a.state * a.ticks, a.ticks)} of ticks; blocked-or-not agrees ${pct(a.blocked * a.ticks, a.ticks)}` +
    (a.reason === null ? '' : `; when both blocked, same reason ${pct(a.reason, 1)} and ${f2(a.blockedAtDiff)} m apart`));
  console.log(`    hazard cells within 6 m, mean per tick: obstacle phone ${f1(a.obstacle.recorded)} / replay ${f1(a.obstacle.replay)} (|Δ| ${f1(a.obstacle.diff)}), ` +
    `drop phone ${f1(a.drop.recorded)} / replay ${f1(a.drop.replay)} (|Δ| ${f1(a.drop.diff)})`);
  console.log(`    runner s off by ${f2(a.runnerSDiff)} m, buddy s by ${f2(a.buddySDiff)} m on average`);
  if (a.final) {
    const { recorded: p, replay: r } = a.final;
    console.log(`    at the end: distrusted frames phone ${p.distrusted} / replay ${r.distrusted} ${flags.has('--logged-depth-only') ? ' (replay fed half as many depth frames)' : ''}, ` +
      `re-based cells ${p.rebased} / ${r.rebased}, map cells ${p.cells} / ${r.cells}`);
  }
  for (const d of a.disagreements) console.log(`    disagreed ${d.from.toFixed(1)}–${d.to.toFixed(1)} s: phone ${d.recorded}, replay ${d.replay}`);
}

function dumpClouds(session: string, segments: Segment[], wanted: Set<number> | 'all', window: number) {
  for (const segment of segments) {
    for (const mark of segment.marks) {
      const n = Number(mark.data?.n);
      if (wanted !== 'all' && !wanted.has(n)) continue;
      const frames = segment.frames.filter(f => f.cloud && Math.abs(f.t - mark.t) <= window);
      const lines = ['t,x,y,z,d,height,verdict'];
      for (const f of frames)
        for (const p of f.cloud!)
          lines.push([f.t, p.x.toFixed(4), p.y.toFixed(4), p.z.toFixed(4), p.d.toFixed(3), Number.isFinite(p.height) ? p.height.toFixed(4) : '', p.verdict].join(','));
      const file = join(CACHE, `${session.replace(/[^\w.-]/g, '-')}-mark${n}.csv`);
      writeFileSync(file, lines.join('\n') + '\n');
      console.log(`Wrote ${lines.length - 1} points from ${frames.length} frames around mark ${n} to ${file}`);
    }
  }
}

// ---------------------------------------------------------------- main

if (positional.length === 0) {
  listSessions();
  process.exit(0);
}

const session = resolveSession(positional[0]);
const rows = loadSession(session);
if (rows.length === 0) fail(`No rows for session "${session}".`);
const window = number('--window') ?? 3;
const dumpAll = flags.has('--dump-marks');
const dumpWanted = new Set((values.get('--dump-mark') ?? []).map(Number));
const markTimes = rows.filter(r => r.kind === 'mark' && (dumpAll || dumpWanted.has(Number(r.data?.n)))).map(r => r.t);
const tuning = parseTuning();
const options: ReplayOptions = {
  tuning,
  walkableStep: number('--walkable-step'),
  pace: number('--pace'),
  fillDepthGaps: !flags.has('--logged-depth-only'),
  mirrorBreaks: !flags.has('--no-breaks'),
  followMe: flags.has('--follow') ? true : flags.has('--fixed') ? false : undefined,
  keepCloud: markTimes.length ? t => markTimes.some(m => Math.abs(t - m) <= window) : undefined,
};

const kinds = new Map<string, number>();
for (const row of rows) kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1);
console.log(`Session ${session}: ${rows.length} rows (${[...kinds].map(([k, n]) => `${n} ${k}`).join(', ')}), ${rows[0].t.toFixed(1)}–${rows.at(-1)!.t.toFixed(1)} s`);
if (Object.keys(tuning).length) console.log(`Tuning: ${Object.entries(tuning).map(([k, v]) => `${k}=${v} (app ${DEFAULT_TUNING[k as keyof SurfaceTuning]})`).join(', ')}`);
if (!kinds.has('frame')) console.log('No raw frames in this session (recorded before frames were logged, or depth was off): only the phone\'s own log can be shown.');

const segments = replaySession(rows, options);
const only = number('--run');
const shown = only === undefined ? segments : segments.filter(s => s.index === only);
if (only !== undefined && shown.length === 0) fail(`No segment ${only}; this session has ${segments.length}.`);
for (const segment of shown) printSegment(segment, window, flags.has('--events-only'));
if (markTimes.length) dumpClouds(session, shown, dumpAll ? 'all' : dumpWanted, window);
