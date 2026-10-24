/**
 * Every line the buddy can say out loud. The voice only ever says one of these fixed texts, so
 * each can be recorded once (`public/audio/lines/<id>.mp3`) and sound cute and consistent;
 * until a clip exists the browser voice reads `text`. Anything specific to the moment (street
 * names, split times, heart rate) goes in the speech bubble instead.
 *
 * No imports and no DOM: the Convex backend reads this file too (see `decisions.ts`), and
 * `npm run voice:lines` exports it as a script for the voice actor or TTS tool.
 */

export type Mood = 'cheer' | 'care' | 'info';
export type LineCategory =
  | 'coach'
  | 'turn'
  | 'split'
  | 'route'
  | 'lap'
  | 'hazard'
  | 'run'
  | 'coin'
  | 'command'
  | 'chat'
  | 'confirm'
  | 'idle';

type LineSpec = {
  id: string;
  /** Exactly what the voice says. */
  text: string;
  mood: Mood;
  category: LineCategory;
  /** Delivery direction for the voice actor or TTS. */
  note?: string;
};

export type Line = LineSpec & { id: LineId };

/** Kilometre splits and laps get their own numbered lines up to these; then a generic one. */
export const MAX_KM_LINE = 10;
export const MAX_LAP_LINE = 20;

type Digit = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type KmNumber = Digit | 10;
type LapNumber = Digit | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20;

const FIXED = [
  // Heart-rate coaching.
  { id: 'coach_ease_off', text: "You're above your zone. Let's ease off a little.", mood: 'care', category: 'coach', note: 'Gentle, caring, not alarmed.' },
  { id: 'coach_breather_auto', text: "Your heart's working hard. Let's take a breather and jog on the spot.", mood: 'care', category: 'coach', note: 'Calm and reassuring; the buddy is stopping for you.' },
  { id: 'coach_breather_ask', text: "Your heart's working hard. Want to take a breather?", mood: 'care', category: 'coach', note: 'A real question, rising at the end.' },
  { id: 'coach_resume_recovered', text: "Heart rate's back down. Ready? Let's go!", mood: 'cheer', category: 'coach', note: 'Bright, building to "Let\'s go!"' },
  { id: 'coach_resume_no_heart', text: "Lost your heart rate, but you've rested a while. Let's go!", mood: 'cheer', category: 'coach' },
  { id: 'coach_heart_lost', text: "I can't see your heart rate right now. I'll keep the pace steady.", mood: 'info', category: 'coach', note: 'Matter-of-fact, not worried.' },
  { id: 'coach_push_1', text: "You've got more in you. Let's pick it up!", mood: 'cheer', category: 'coach', note: 'Playful nudge.' },
  { id: 'coach_push_2', text: 'Little faster? You can do it!', mood: 'cheer', category: 'coach', note: 'Playful nudge.' },
  { id: 'coach_push_3', text: "Let's push the pace a touch!", mood: 'cheer', category: 'coach', note: 'Playful nudge.' },
  { id: 'coach_encourage_1', text: 'Nice rhythm. Right in the zone!', mood: 'cheer', category: 'coach', note: 'Warm, mid-run cheer.' },
  { id: 'coach_encourage_2', text: "You're cruising. Love it.", mood: 'cheer', category: 'coach', note: 'Warm, mid-run cheer.' },
  { id: 'coach_encourage_3', text: 'Breathe easy, you are doing great.', mood: 'cheer', category: 'coach', note: 'Soft and calm.' },
  { id: 'coach_encourage_4', text: 'Steady and strong. Keep it up!', mood: 'cheer', category: 'coach', note: 'Warm, mid-run cheer.' },
  { id: 'coach_encourage_5', text: 'This pace looks good on you.', mood: 'cheer', category: 'coach', note: 'A little cheeky.' },
  { id: 'coach_encourage_6', text: "Look at you go! We're a great team.", mood: 'cheer', category: 'coach', note: 'Delighted.' },

  // Turns. The bubble names the street and the distance.
  { id: 'turn_left', text: 'Left turn coming up!', mood: 'info', category: 'turn', note: 'Clear and upbeat; stress "Left".' },
  { id: 'turn_right', text: 'Right turn coming up!', mood: 'info', category: 'turn', note: 'Clear and upbeat; stress "Right".' },
  { id: 'turn_slight_left', text: 'Bear left up ahead.', mood: 'info', category: 'turn' },
  { id: 'turn_slight_right', text: 'Bear right up ahead.', mood: 'info', category: 'turn' },
  { id: 'turn_sharp_left', text: 'Sharp left up ahead!', mood: 'info', category: 'turn', note: 'A touch more urgent.' },
  { id: 'turn_sharp_right', text: 'Sharp right up ahead!', mood: 'info', category: 'turn', note: 'A touch more urgent.' },
  { id: 'turn_uturn', text: 'Turn around up here.', mood: 'info', category: 'turn' },
  { id: 'turn_double', text: 'Two turns coming up!', mood: 'info', category: 'turn', note: 'Heads-up; the bubble shows both.' },

  // Kilometre splits beyond the numbered ones (the bubble has the split time).
  { id: 'split_km_more', text: 'Another K done!', mood: 'cheer', category: 'split', note: 'Proud.' },

  // Route milestones.
  { id: 'route_halfway', text: "Halfway there! You're doing great.", mood: 'cheer', category: 'route', note: 'Excited.' },
  { id: 'route_final_stretch', text: 'Last hundred metres. Finish strong!', mood: 'cheer', category: 'route', note: 'Big energy, building.' },

  // Laps beyond the numbered ones.
  { id: 'lap_more', text: 'Another lap done!', mood: 'cheer', category: 'lap' },

  // Things in the way.
  { id: 'hazard_blocked', text: "Whoa, something's blocking the way.", mood: 'care', category: 'hazard', note: 'Surprised, then calm.' },
  { id: 'hazard_drop', text: "Careful! There's a drop ahead.", mood: 'care', category: 'hazard', note: 'Urgent but not scary.' },
  { id: 'hazard_stairs', text: "Stairs ahead! Let's take them easy.", mood: 'care', category: 'hazard' },
  { id: 'hazard_detour', text: "Something's in the way. Follow me around it!", mood: 'info', category: 'hazard', note: 'Confident, leading.' },

  // The run itself.
  { id: 'run_start_1', text: "Let's go! I'll lead the way.", mood: 'cheer', category: 'run', note: 'Excited start.' },
  { id: 'run_start_2', text: "Ready, set, run! Follow me!", mood: 'cheer', category: 'run', note: 'Excited start.' },
  { id: 'run_start_3', text: "Here we go! Stay with me.", mood: 'cheer', category: 'run', note: 'Excited start.' },
  { id: 'run_finish', text: 'We made it! Great run.', mood: 'cheer', category: 'run', note: 'Proud, celebratory.' },
  { id: 'course_ready_loop', text: "Loop's ready. Let's go!", mood: 'cheer', category: 'run', note: 'Pleased with the course you drew.' },
  { id: 'course_ready_line', text: "Out and back it is. Let's go!", mood: 'cheer', category: 'run', note: 'Pleased with the course you drew.' },
  { id: 'run_tracking_lost', text: "I can't see the ground. Point your phone at the floor ahead.", mood: 'info', category: 'run', note: 'Helpful, unhurried.' },

  // Coin pickups. Short and squeaky; only said when the buddy isn't already talking.
  { id: 'coin_1', text: 'Cha-ching!', mood: 'cheer', category: 'coin', note: 'Quick, squeaky, delighted.' },
  { id: 'coin_2', text: 'Shiny!', mood: 'cheer', category: 'coin', note: 'Quick, squeaky, delighted.' },
  { id: 'coin_3', text: 'Ooh, a coin!', mood: 'cheer', category: 'coin', note: 'Quick, squeaky, delighted.' },
  { id: 'coin_4', text: 'Treasure!', mood: 'cheer', category: 'coin', note: 'Quick, squeaky, delighted.' },
  { id: 'coin_5', text: 'Got it!', mood: 'cheer', category: 'coin', note: 'Quick, squeaky, delighted.' },

  // Answers to voice commands.
  { id: 'cmd_break', text: 'Sure, breather time. Jog on the spot with me.', mood: 'care', category: 'command' },
  { id: 'cmd_break_unwell', text: "Let's stop right here. If you feel unwell, please get help.", mood: 'care', category: 'command', note: 'Serious and kind; slower.' },
  { id: 'cmd_go', text: "Alright, let's go!", mood: 'cheer', category: 'command' },
  { id: 'cmd_go_cheer', text: 'Woohoo! Back to it!', mood: 'cheer', category: 'command', note: 'Bouncy.' },
  { id: 'cmd_go_already', text: "I'm right here. Let's keep it up!", mood: 'cheer', category: 'command' },
  { id: 'cmd_faster', text: 'Picking it up!', mood: 'cheer', category: 'command' },
  { id: 'cmd_faster_2', text: "Ooh, let's fly!", mood: 'cheer', category: 'command', note: 'Gleeful.' },
  { id: 'cmd_slower', text: 'Easing off. Nice and steady.', mood: 'care', category: 'command' },
  { id: 'cmd_slower_2', text: "Let's take it easy for a bit.", mood: 'care', category: 'command' },
  { id: 'cmd_status', text: "Here's how you're doing. Looking great!", mood: 'info', category: 'command', note: 'The bubble shows distance, pace and heart rate.' },
  { id: 'cmd_finish', text: 'Great run! Wrapping up.', mood: 'cheer', category: 'command' },
  { id: 'cmd_unknown', text: "Sorry, I didn't catch that.", mood: 'info', category: 'command', note: 'Apologetic, light.' },

  // Replies when the runner is just talking (no action).
  { id: 'chat_ack', text: "I hear you! Let's keep moving.", mood: 'cheer', category: 'chat' },
  { id: 'chat_encourage', text: "You're doing amazing. Keep it up!", mood: 'cheer', category: 'chat' },
  { id: 'chat_tough', text: "Tough bit! Short steps, you've got this.", mood: 'cheer', category: 'chat', note: 'Empathetic, then encouraging.' },
  { id: 'chat_thanks', text: "Aw, thanks! You're a great running buddy.", mood: 'cheer', category: 'chat', note: 'Bashful.' },
  { id: 'chat_laugh', text: 'Ha! You crack me up.', mood: 'cheer', category: 'chat', note: 'Giggle first.' },

  // The yes/no flow.
  { id: 'confirm_ask_break', text: 'Want to take a break?', mood: 'care', category: 'confirm', note: 'A real question, rising at the end.' },
  { id: 'confirm_ask_break_tired', text: 'Sounds tough. Want to take a breather?', mood: 'care', category: 'confirm', note: 'Sympathetic question.' },
  { id: 'confirm_yes_break', text: "Okay, let's stop here.", mood: 'care', category: 'confirm' },
  { id: 'confirm_no', text: "No worries, let's keep going.", mood: 'cheer', category: 'confirm' },

  // Standing around waiting for the runner.
  { id: 'idle_wait_1', text: "I'll wait up for you!", mood: 'cheer', category: 'idle', note: 'Patient, friendly.' },
  { id: 'idle_wait_2', text: 'Over here! Catch up when you can.', mood: 'cheer', category: 'idle', note: 'Waving.' },
  { id: 'idle_wait_3', text: 'Ready when you are!', mood: 'cheer', category: 'idle' },
  { id: 'idle_break_1', text: 'Take your time. Say "let\'s go" when you\'re ready.', mood: 'care', category: 'idle', note: 'Relaxed.' },
  { id: 'idle_break_2', text: 'Nice deep breaths. In, and out.', mood: 'care', category: 'idle', note: 'Slow and soothing.' },
  { id: 'idle_break_3', text: 'Shake out those legs!', mood: 'cheer', category: 'idle', note: 'Playful.' },
] as const satisfies readonly LineSpec[];

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const capitalised = (n: number) => NUMBER_WORDS[n].charAt(0).toUpperCase() + NUMBER_WORDS[n].slice(1);

const KM_LINES: Line[] = Array.from({ length: MAX_KM_LINE }, (_, i) => {
  const km = i + 1;
  const tail = km === 5 ? ' Halfway to ten!' : km === 10 ? ' Amazing!' : '';
  return { id: `split_km_${km as KmNumber}`, text: `${capitalised(km)} K done!${tail}`, mood: 'cheer', category: 'split', note: 'Proud; the bubble shows the split time.' };
});

const LAP_CHEERS = ["That's lap {n}!", 'Lap {n} done. Looking good!', 'Lap {n}! Keep that rhythm.', "Lap {n}. You're flying!"];
const LAP_LINES: Line[] = Array.from({ length: MAX_LAP_LINE }, (_, i) => {
  const lap = i + 1;
  return { id: `lap_${lap as LapNumber}`, text: LAP_CHEERS[i % LAP_CHEERS.length].replace('{n}', NUMBER_WORDS[lap]), mood: 'cheer', category: 'lap' };
});

export type LineId = (typeof FIXED)[number]['id'] | `split_km_${KmNumber}` | `lap_${LapNumber}`;

export const LINES: readonly Line[] = [...(FIXED as readonly Line[]), ...KM_LINES, ...LAP_LINES];

const BY_ID = new Map<string, Line>(LINES.map(line => [line.id, line]));

export function isLineId(id: string): id is LineId {
  return BY_ID.has(id);
}

export function lineById(id: LineId): Line {
  const line = BY_ID.get(id);
  if (!line) throw new Error(`Unknown voice line "${id}"`);
  return line;
}

/** The file a recorded clip for this line lives at, relative to the site root. */
export function clipPath(id: LineId) {
  return `audio/lines/${id}.mp3`;
}

/** The numbered split line, or the generic one past ten. */
export function kmLineId(km: number): LineId {
  return km >= 1 && km <= MAX_KM_LINE ? (`split_km_${km}` as LineId) : 'split_km_more';
}

/** The numbered lap line, or the generic one past twenty. */
export function lapLineId(lap: number): LineId {
  return lap >= 1 && lap <= MAX_LAP_LINE ? (`lap_${lap}` as LineId) : 'lap_more';
}

/** Lines said in turn, so the same words don't come round every time. */
export const ENCOURAGEMENT: readonly LineId[] = ['coach_encourage_1', 'coach_encourage_2', 'coach_encourage_3', 'coach_encourage_4', 'coach_encourage_5', 'coach_encourage_6'];
export const PUSH: readonly LineId[] = ['coach_push_1', 'coach_push_2', 'coach_push_3'];
export const COIN_QUIPS: readonly LineId[] = ['coin_1', 'coin_2', 'coin_3', 'coin_4', 'coin_5'];
export const RUN_STARTS: readonly LineId[] = ['run_start_1', 'run_start_2', 'run_start_3'];
export const IDLE_WAIT: readonly LineId[] = ['idle_wait_1', 'idle_wait_2', 'idle_wait_3'];
export const IDLE_BREAK: readonly LineId[] = ['idle_break_1', 'idle_break_2', 'idle_break_3'];

/**
 * A moment the buddy speaks: which line the voice says, and optionally richer text for the
 * speech bubble (defaults to the line's own text).
 */
export type Spoken = { id: LineId; bubble?: string };

export function bubbleText(spoken: Spoken) {
  return spoken.bubble ?? lineById(spoken.id).text;
}
