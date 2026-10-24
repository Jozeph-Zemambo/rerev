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
const RECONNECT_TRIES = 5;

export type BluetoothState = 'off' | 'connecting' | 'connected' | 'lost';

export class BluetoothHeartRate {
  readonly supported = !!bluetooth;
  state: BluetoothState = 'off';
  deviceName = '';
  onReading: (bpm: number) => void = () => {};
  onState: (state: BluetoothState) => void = () => {};
  private device: Device | null = null;

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

  /** The watch dropped out (asleep, out of range): try again a few times, backing off. */
  private async reconnect(device: Device) {
    if (this.device !== device) return;
    this.setState('lost');
    for (let attempt = 1; attempt <= RECONNECT_TRIES && this.device === device; attempt++) {
      await new Promise(resolve => setTimeout(resolve, attempt * 1500));
      try {
        await this.subscribe(device);
        return;
      } catch {
        // Still out of reach; try again.
      }
    }
    if (this.device === device) this.setState('lost');
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
