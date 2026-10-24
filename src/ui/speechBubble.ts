import * as THREE from 'three';
import { BUDDY_HEIGHT } from '../partner/mascot';
import type { Mood } from '../voice/lines';

export type BubbleLine = { text: string; mood: Mood };

/** How high above the buddy's feet the bubble's tail points: just over its head. */
const HEAD_HEIGHT = BUDDY_HEIGHT + 0.12;

/**
 * A speech bubble that floats above the buddy's head. It lives in the DOM overlay (so it also
 * shows during AR) and is moved every frame to wherever the head projects on screen.
 */
export class SpeechBubble {
  private readonly el: HTMLDivElement;
  private readonly text: HTMLSpanElement;
  private hideAt = 0;
  private readonly world = new THREE.Vector3();

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'bubble';
    this.el.hidden = true;
    this.el.setAttribute('role', 'status');
    this.text = document.createElement('span');
    this.el.appendChild(this.text);
    parent.appendChild(this.el);
  }

  show(line: BubbleLine, now: number) {
    this.text.textContent = line.text;
    this.el.dataset.mood = line.mood;
    this.el.hidden = false;
    // Restart the pop-in animation.
    this.el.classList.remove('pop');
    void this.el.offsetWidth;
    this.el.classList.add('pop');
    const words = line.text.split(/\s+/).length;
    this.hideAt = now + Math.max(3.5, words * 0.42);
  }

  /** Keep the bubble over the buddy's head. Hides itself when its time is up or the head is off-screen. */
  update(buddyFeet: THREE.Vector3, camera: THREE.Camera, now: number) {
    if (this.el.hidden) return;
    if (now > this.hideAt) {
      this.el.hidden = true;
      return;
    }
    this.world.copy(buddyFeet).setY(buddyFeet.y + HEAD_HEIGHT).project(camera);
    const behind = this.world.z > 1;
    const x = THREE.MathUtils.clamp((this.world.x + 1) / 2, 0.12, 0.88) * innerWidth;
    const y = THREE.MathUtils.clamp((1 - this.world.y) / 2, 0.22, 0.7) * innerHeight;
    this.el.style.visibility = behind ? 'hidden' : 'visible';
    this.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
  }

  hide() {
    this.el.hidden = true;
  }
}
