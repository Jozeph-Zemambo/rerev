import * as THREE from 'three';
import { BUDDY_NAMES, BUDDY_PITCH, type BuddyColor } from '../partner/buddies';
import { BOOTH_MOTION } from '../partner/buddyMotion';
import { BUDDY_HEIGHT, Mascot } from '../partner/mascot';
import { SpeechBubble } from '../ui/speechBubble';
import type { LineVoice } from '../ui/voice';
import { BOOTH_LINES, lineById } from '../voice/lines';
import { createShadow } from '../world/shadow';
import { BoothChatter, lowestFloor, standHeight } from './boothRules';

/** Placed in this order: tap where Rev stands, then where Vita stands. */
const ORDER: BuddyColor[] = ['blue', 'pink'];
/** On screen means within this much of the middle (normalised device coordinates). */
const IN_VIEW_X = 0.75;
const IN_VIEW_Y = 0.9;

type Stand = {
  color: BuddyColor;
  mascot: Mascot;
  /** True for the app's own buddy, which is only lent to the booth (not disposed). */
  borrowed: boolean;
  shadow: THREE.Mesh;
  bubble: SpeechBubble;
  placed: boolean;
  at: THREE.Vector3;
  height: number;
  line: number;
};

/**
 * Booth mode, for the demo table: both buddies stand in the room where you tap them (the floor
 * at full size, a table top as figurines), anchored by AR tracking like the running buddy.
 * Rev idles, Vita waves, and each says hello when you turn the phone to it.
 *
 * Borrows the app's own buddy for whichever of the two it already is, and makes the other only
 * for as long as the booth is on.
 */
export class Booth {
  private stands: Stand[] = [];
  private floorY: number | null = null;
  private readonly chatter = new BoothChatter();
  private readonly probe = new THREE.Vector3();
  private readonly scene: THREE.Scene;
  private readonly overlay: HTMLElement;
  private readonly voice: LineVoice;

  /** `overlay` holds the speech bubbles (the AR DOM overlay). */
  constructor(scene: THREE.Scene, overlay: HTMLElement, voice: LineVoice) {
    this.scene = scene;
    this.overlay = overlay;
    this.voice = voice;
  }

  get active() {
    return this.stands.length > 0;
  }

  /** Whose spot is being chosen, or null once both stand. */
  get placing(): BuddyColor | null {
    return this.stands.find(stand => !stand.placed)?.color ?? null;
  }

  /** What to tell the person holding the phone. */
  message(ringShown: boolean): string {
    const next = this.placing;
    if (!next) return '';
    const name = BUDDY_NAMES[next];
    return ringShown ? `Tap where ${name} should stand.` : `Point at the floor or a table top. When the ring appears, tap where ${name} should stand.`;
  }

  /** `appBuddy` is the app's own Mascot and the colour it is now. */
  start(appBuddy: Mascot, appColor: BuddyColor) {
    this.stop();
    this.floorY = null;
    this.chatter.reset();
    this.stands = ORDER.map(color => {
      const borrowed = color === appColor;
      const mascot = borrowed ? appBuddy : new Mascot(color);
      mascot.root.visible = false;
      if (!borrowed) this.scene.add(mascot.root);
      const shadow = createShadow();
      shadow.visible = false;
      this.scene.add(shadow);
      return { color, mascot, borrowed, shadow, bubble: new SpeechBubble(this.overlay), placed: false, at: new THREE.Vector3(), height: BUDDY_HEIGHT, line: 0 };
    });
  }

  /** Put both away: the made buddy is freed, the borrowed one handed back hidden and full size. */
  stop() {
    for (const stand of this.stands) {
      stand.bubble.remove();
      stand.shadow.removeFromParent();
      stand.shadow.geometry.dispose();
      const material = stand.shadow.material as THREE.MeshBasicMaterial;
      material.map?.dispose();
      material.dispose();
      if (stand.borrowed) {
        stand.mascot.root.visible = false;
        stand.mascot.root.scale.setScalar(1);
      } else stand.mascot.dispose();
    }
    this.stands = [];
    this.voice.stop();
  }

  /** A horizontal surface was seen at `surfaceY` from a phone at `phoneY`: learn where the floor is. */
  noteSurface(surfaceY: number, phoneY: number) {
    this.floorY = lowestFloor(this.floorY, surfaceY, phoneY);
  }

  /** How tall the next buddy would stand on a surface at `surfaceY` (to size the ring). */
  heightOn(surfaceY: number, phoneY: number) {
    return standHeight(surfaceY, this.floorY, phoneY);
  }

  /** Stand the next buddy at `at` (on a surface), facing the phone at `phone`. */
  place(at: THREE.Vector3, phone: THREE.Vector3) {
    const stand = this.stands.find(s => !s.placed);
    if (!stand) return;
    stand.placed = true;
    stand.at.copy(at);
    stand.height = this.heightOn(at.y, phone.y);
    const root = stand.mascot.root;
    root.position.copy(at);
    root.scale.setScalar(stand.height / BUDDY_HEIGHT);
    root.rotation.set(0, Math.atan2(phone.x - at.x, phone.z - at.z), 0);
    root.visible = true;
    stand.shadow.position.set(at.x, at.y + 0.003, at.z);
    stand.shadow.scale.setScalar(stand.height / BUDDY_HEIGHT);
    stand.shadow.visible = true;
  }

  /** Choose both spots again, Rev first. */
  move() {
    for (const stand of this.stands) {
      stand.placed = false;
      stand.mascot.root.visible = stand.shadow.visible = false;
      stand.bubble.hide();
    }
    this.voice.stop();
    this.chatter.reset();
  }

  /** Every frame: animate, keep facing the phone, and say hello to whoever looks. */
  update(dt: number, seconds: number, now: number, phone: THREE.Vector3, camera: THREE.Camera) {
    const inView = { blue: false, pink: false };
    for (const stand of this.stands) {
      if (!stand.placed) continue;
      const root = stand.mascot.root;
      const facing = Math.atan2(phone.x - stand.at.x, phone.z - stand.at.z);
      const turn = Math.atan2(Math.sin(facing - root.rotation.y), Math.cos(facing - root.rotation.y));
      root.rotation.y += turn * Math.min(1, dt * 3);
      stand.mascot.perform(dt, seconds, BOOTH_MOTION[stand.color]);
      stand.bubble.update(stand.at, camera, now, stand.height);
      // In view: its middle is on screen, in front of the camera.
      this.probe.copy(stand.at).setY(stand.at.y + stand.height / 2).project(camera);
      inView[stand.color] = this.probe.z < 1 && Math.abs(this.probe.x) < IN_VIEW_X && Math.abs(this.probe.y) < IN_VIEW_Y;
    }
    if (this.placing) return;
    const speaker = this.chatter.update(now, inView, this.voice.busy);
    if (speaker) this.say(speaker, now);
  }

  private say(color: BuddyColor, now: number) {
    const stand = this.stands.find(s => s.color === color)!;
    const lines = BOOTH_LINES[color];
    const id = lines[stand.line++ % lines.length];
    stand.bubble.show({ text: lineById(id).text, mood: lineById(id).mood }, now);
    this.voice.say(id, { pitch: BUDDY_PITCH[color] });
  }
}
