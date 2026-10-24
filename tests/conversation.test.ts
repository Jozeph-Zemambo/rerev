import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, PendingQuestion, QUESTION_TIMEOUT, routeTranscript, softDecision } from '../src/voice/conversation';

test('a question stays open until answered or timed out', () => {
  const question = new PendingQuestion();
  assert.equal(question.current(0), null);
  question.ask('break', 100);
  assert.equal(question.current(100 + QUESTION_TIMEOUT - 0.1), 'break');
  assert.equal(question.current(100 + QUESTION_TIMEOUT + 0.1), null);
  // Once it has timed out it stays gone.
  assert.equal(question.current(100), null);
  question.ask('break', 200);
  question.clear();
  assert.equal(question.current(200), null);
});

test('yes and no are recognised, and mixed answers are not', () => {
  for (const said of ['yes', 'Yeah', 'sure', 'ok', 'okay please', 'yep, let\'s do it']) assert.equal(answerOf(said), 'yes', said);
  for (const said of ['no', 'nah', 'nope', 'keep going', "I'm good", 'not yet']) assert.equal(answerOf(said), 'no', said);
  for (const said of ['yes no', 'banana', '']) assert.equal(answerOf(said), null, said);
});

test('with a question open, yes and no answer it on the phone', () => {
  assert.deepEqual(routeTranscript('yeah', 'break'), { kind: 'answer', answer: 'yes' });
  assert.deepEqual(routeTranscript('nah, keep going', 'break'), { kind: 'answer', answer: 'no' });
  // A clear stop is a stop, whatever the wording around it.
  assert.deepEqual(routeTranscript('no, I need to stop', 'break'), { kind: 'intent', intent: 'break' });
  // Without a question, "yes" means nothing to the keywords.
  assert.equal(routeTranscript('yes', null).kind, 'claude');
});

test('clear commands stay on the phone; soft and unknown phrases go to Claude', () => {
  assert.deepEqual(routeTranscript('stop', null), { kind: 'intent', intent: 'break' });
  assert.deepEqual(routeTranscript('go faster', null), { kind: 'intent', intent: 'faster' });
  assert.deepEqual(routeTranscript("let's go", null), { kind: 'intent', intent: 'go' });
  assert.deepEqual(routeTranscript('end the run', null), { kind: 'intent', intent: 'finish' });
  assert.deepEqual(routeTranscript("I'm tired", null), { kind: 'claude', fallback: { action: 'ask_break', lineId: 'confirm_ask_break_tired' } });
  assert.deepEqual(routeTranscript('man, this is steep', null), { kind: 'claude', fallback: { action: 'none', lineId: 'chat_tough' } });
  assert.deepEqual(routeTranscript('nice weather today', null), { kind: 'claude', fallback: null });
});

test('soft phrases ask or encourage, never act', () => {
  assert.equal(softDecision('I am exhausted')?.action, 'ask_break');
  assert.equal(softDecision('my legs are dying')?.action, 'ask_break');
  assert.equal(softDecision('ugh this hill')?.action, 'none');
  assert.equal(softDecision('what time is it'), null);
});

test('feeling unwell stops the run even without Claude', () => {
  for (const said of ['my chest hurts', "I'm feeling dizzy", 'I feel sick', 'kind of lightheaded']) {
    assert.deepEqual(softDecision(said), { action: 'break', lineId: 'cmd_break_unwell' }, said);
  }
  assert.equal(softDecision('my legs hurt')?.action, 'ask_break');
});
