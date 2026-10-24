import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent } from '../src/ui/voiceCommands';

test('voice commands map to the right intent', () => {
  const cases: [string, ReturnType<typeof parseIntent>][] = [
    ['go faster', 'faster'],
    ['pick it up', 'faster'],
    ['slow down a bit', 'slower'],
    ["that's too fast", 'slower'],
    ["let's go", 'go'],
    ["don't stop", 'go'],
    ['keep going', 'go'],
    ['I need a break', 'break'],
    ['wait for me', 'break'],
    ["I can't breathe", 'break'],
    ['stop the run', 'finish'],
    ["I'm done", 'finish'],
    ['how am I doing?', 'status'],
    ["what's my heart rate", 'status'],
    ['nice weather today', 'unknown'],
  ];
  for (const [said, intent] of cases) assert.equal(parseIntent(said), intent, said);
});
