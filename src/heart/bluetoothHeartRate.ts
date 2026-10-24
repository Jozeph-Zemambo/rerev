/**
 * Heart rate straight from the watch over Bluetooth, no laptop or Wi-Fi in between. The watch
 * runs an app (e.g. "Heart for Bluetooth" or "HR2VP" on Wear OS) that makes it look like a
 * standard Bluetooth heart-rate strap, and Chrome on Android reads it with Web Bluetooth.
 */

// Web Bluetooth isn't in TypeScript's DOM typings yet; just the parts used here.
type Characteristic = EventTarget & { value?: DataView; startNotifications(): Promise<Characteristic> };
type Service = { getCharacteristic(name: string): Promise<Characteristic> };
type Server = { connected: boolean; connect(): Promise<Server>; disconnect(): void; getPrimaryService(name: string): Promise<Service> };
type Device = EventTarget & { name?: string; gatt?: Server };
type Bluetooth = {
  requestDevice(options: { filters: { services: string[] }[] }): Promise<Device>;
  getDevices?(): Promise<Device[]>;
};

const bluetooth = (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;
/**
 * After a drop, keep trying to reconnect this often for as long as the page is open. Reconnecting
 * to a watch already picked needs no tap, only the watch advertising again (its app's "beacon").
 */
const RECONNECT_EVERY = 4000;

export type BluetoothState = 'off' | 'connecting' | 'connected' | 'lost';

export class BluetoothHeartRate {
  readonly supported = !!bluetooth;
  state: BluetoothState = 'off';
  deviceName = '';
  onReading: (bpm: number) => void = () => {};
  onState: (state: BluetoothState) => void = () => {};
  private device: Device | null = null;
  private retrying = false;

  /** Pick the watch from Chrome's chooser. Must be called from a tap. */
  async pair() {
    if (!bluetooth) throw new Error('This browser has no Bluetooth access. Use Chrome on Android.');
    const device = await bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    await this.use(device).catch(error => {
      this.disconnect();
      throw error;
    });
  }

  /** Reconnect to a watch paired on an earlier visit, if Chrome remembers it (no tap needed). */
  async resume() {
    const known = await bluetooth?.getDevices?.().catch(() => []);
    if (known?.[0]) await this.use(known[0]).catch(() => this.setState('off'));
  }

  disconnect() {
    const device = this.device;
    this.device = null;
    device?.gatt?.disconnect();
    this.setState('off');
  }

  private async use(device: Device) {
    this.device = device;
    this.deviceName = device.name ?? 'Watch';
    device.addEventListener('gattserverdisconnected', () => void this.reconnect(device));
    await this.subscribe(device);
  }

  private async subscribe(device: Device) {
    this.setState('connecting');
    const server = await device.gatt!.connect();
    const service = await server.getPrimaryService('heart_rate');
    const measurement = await service.getCharacteristic('heart_rate_measurement');
    measurement.addEventListener('characteristicvaluechanged', () => {
      const bpm = measurement.value && parseHeartRate(measurement.value);
      if (bpm) this.onReading(bpm);
    });
    await measurement.startNotifications();
    this.setState('connected');
  }

  /** The watch dropped out (asleep, out of range, beacon off): keep trying until it's back. */
  private async reconnect(device: Device) {
    if (this.device !== device || this.retrying) return;
    this.retrying = true;
    this.setState('lost');
    try {
      while (this.device === device) {
        await new Promise(resolve => setTimeout(resolve, RECONNECT_EVERY));
        if (this.device !== device) return;
        try {
          await this.subscribe(device);
          return;
        } catch {
          // Still out of reach (or the beacon is off); try again.
          this.setState('lost');
        }
      }
    } finally {
      this.retrying = false;
    }
  }

  private setState(state: BluetoothState) {
    this.state = state;
    this.onState(state);
  }
}

/**
 * The standard Heart Rate Measurement value: a flags byte, then the rate as one byte, or two
 * bytes little-endian when bit 0 of the flags is set.
 */
export function parseHeartRate(value: DataView): number | null {
  if (value.byteLength < 2) return null;
  const wide = (value.getUint8(0) & 0x01) === 1;
  if (wide && value.byteLength < 3) return null;
  const bpm = wide ? value.getUint16(1, true) : value.getUint8(1);
  return bpm >= 25 && bpm <= 240 ? bpm : null;
}
