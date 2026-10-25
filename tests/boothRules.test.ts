import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoothChatter, FIGURINE_HEIGHT, FLOOR_HEIGHT, lowestFloor, OWN_GAP, PAIR_GAP, SEEN_FOR, standHeight } from '../src/booth/boothRules';

// Heights in an AR session's own frame: y = 0 is wherever the phone started, not the floor.
const SEATED = 1.1;
const STANDING = 1.45;

test('on the floor a buddy is full size; on a table it is a figurine', () => {
  // Seated at the demo table: floor 1.1 m under the phone, table top 0.75 m above the floor.
  const floor = lowestFloor(null, -SEATED, 0);
  assert.equal(floor, -SEATED);
  assert.equal(standHeight(-SEATED, floor, 0), FLOOR_HEIGHT);
  assert.equal(standHeight(-SEATED + 0.75, floor, 0), FIGURINE_HEIGHT);
  // A coffee table counts as raised too; a slightly uneven floor doesn't.
  assert.equal(standHeight(-SEATED + 0.4, floor, 0), FIGURINE_HEIGHT);
  assert.equal(standHeight(-SEATED + 0.05, floor, 0), FLOOR_HEIGHT);
});

test('measured from the floor, it does not matter how the phone is held', () => {
  const floor = -1.2;
  for (const phoneY of [-0.5, 0, 0.6]) {
    assert.equal(standHeight(floor + 0.75, floor, phoneY), FIGURINE_HEIGHT);
    assert.equal(standHeight(floor, floor, phoneY), FLOOR_HEIGHT);
  }
});

test('with only the table seen, it is judged from the phone', () => {
  // Seated or standing, a table top is well within 0.8 m of the phone; the floor is not.
  const table = lowestFloor(null, -SEATED + 0.75, 0);
  assert.equal(table, null, 'a table top is never taken for the floor');
  assert.equal(standHeight(-SEATED + 0.75, null, 0), FIGURINE_HEIGHT);
  assert.equal(standHeight(-STANDING + 0.75, null, 0), FIGURINE_HEIGHT);
  assert.equal(standHeight(-SEATED, null, 0), FLOOR_HEIGHT);
  assert.equal(standHeight(-STANDING, null, 0), FLOOR_HEIGHT);
});

test('the floor is the lowest surface seen well below the phone', () => {
  let floor: number | null = null;
  floor = lowestFloor(floor, -0.35, 0); // the table, close under the phone
  assert.equal(floor, null);
  floor = lowestFloor(floor, -1.1, 0);
  floor = lowestFloor(floor, -1.05, 0);
  assert.equal(floor, -1.1);
  // Standing up later doesn't turn the table into the floor.
  floor = lowestFloor(floor, -0.35, 0.4);
  assert.equal(floor, -1.1);
});

test('each buddy talks when it comes into view, then not again for a while', () => {
  const chatter = new BoothChatter();
  const view = (blue: boolean, pink: boolean) => ({ blue, pink });
  // Turn to Rev: he speaks once he's been in view a moment.
  assert.equal(chatter.update(0, view(true, false), false), null);
  assert.equal(chatter.update(SEEN_FOR + 0.01, view(true, false), false), 'blue');
  assert.equal(chatter.update(SEEN_FOR + 1, view(true, false), false), null);
  // Turn to Vita: she waits until Rev's line has had its room.
  assert.equal(chatter.update(2, view(false, true), false), null);
  assert.equal(chatter.update(SEEN_FOR + PAIR_GAP + 0.02, view(false, true), false), 'pink');
  // Not over the voice, and Rev not again until his own gap is up.
  const later = SEEN_FOR + 0.01 + OWN_GAP;
  assert.equal(chatter.update(later - 1, view(true, true), false), null);
  assert.equal(chatter.update(later, view(true, true), true), null);
  assert.equal(chatter.update(later + 0.1, view(true, true), false), 'blue');
});

test('a buddy out of view says nothing', () => {
  const chatter = new BoothChatter();
  for (let t = 0; t < 60; t += 0.5) assert.equal(chatter.update(t, { blue: false, pink: false }, false), null);
});
