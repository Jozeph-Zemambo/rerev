import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeartRate } from '../src/heart/bluetoothHeartRate';

const reading = (...bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

test('reads one-byte and two-byte heart rate values', () => {
  assert.equal(parseHeartRate(reading(0x00, 72)), 72);
  assert.equal(parseHeartRate(reading(0x16, 140, 0x01, 0x02)), 140); // extra fields after the rate
  assert.equal(parseHeartRate(reading(0x01, 0xb4, 0x00)), 180); // 16-bit, little-endian
});

test('ignores truncated or impossible values', () => {
  assert.equal(parseHeartRate(reading(0x00)), null);
  assert.equal(parseHeartRate(reading(0x01, 0x50)), null);
  assert.equal(parseHeartRate(reading(0x00, 0)), null);
});
