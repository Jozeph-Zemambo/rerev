import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WAIT, SpeechQueue } from '../src/voice/speechQueue';

/** A queue whose lines finish only when the test says so. */
function setup() {
  let now = 0;
  const started: string[] = [];
  const finish: (() => void)[] = [];
  let cuts = 0;
  const queue = new SpeechQueue<string>(
    (line, done) => {
      started.push(line);
      finish.push(done);
    },
    () => cuts++,
    () => now,
  );
  return { queue, started, finish, cuts: () => cuts, tick: (seconds: number) => (now += seconds) };
}

test('lines play one at a time, in order', () => {
  const { queue, started, finish } = setup();
  queue.add('a');
  queue.add('b');
  assert.deepEqual(started, ['a']);
  finish[0]();
  assert.deepEqual(started, ['a', 'b']);
  finish[1]();
  assert.equal(queue.busy, false);
});

test('an interrupting line cuts the current one and drops the queue', () => {
  const { queue, started, finish, cuts } = setup();
  queue.add('a');
  queue.add('b');
  queue.add('urgent', { interrupt: true });
  assert.equal(cuts(), 1);
  assert.deepEqual(started, ['a', 'urgent']);
  // The cut line's late "done" must not skip the urgent one.
  finish[0]();
  assert.deepEqual(started, ['a', 'urgent']);
  finish[1]();
  assert.equal(queue.busy, false);
});

test('idle-only lines are dropped while the buddy is talking', () => {
  const { queue, started, finish } = setup();
  queue.add('a');
  queue.add('coin', { ifIdle: true });
  finish[0]();
  assert.deepEqual(started, ['a']);
  queue.add('coin', { ifIdle: true });
  assert.deepEqual(started, ['a', 'coin']);
});

test('lines that waited too long are skipped', () => {
  const { queue, started, finish, tick } = setup();
  queue.add('a');
  queue.add('turn');
  queue.add('later');
  tick(MAX_WAIT + 1);
  queue.add('fresh');
  finish[0]();
  assert.deepEqual(started, ['a', 'fresh']);
});
