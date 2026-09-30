/**
 * One simulated dog: replays its IMU subject and heart-rate subject in 10 s blocks (looping at the end) and adds a
 * synthetic temperature. Injections are applied on top with the shared catalog (shared/anomalies.ts).
 *
 * Heart rate with `hrBreaks`: the series joins stretches separated by gaps or sessions. Each stretch fills
 * whole blocks and its last block may be short, as with a sensor that loses the signal, so the engine sees the gap
 * instead of a jump of several bpm inside a minute. The loop back to the start is a gap too.
 */
import { BLOCK_SAMPLES, BLOCK_SECONDS, IMU_CHANNELS } from "./config";
import { applyInjections, type ActiveInjection } from "../../shared/anomalies";
import { TemperatureSeries } from "../../shared/synthetic";
import type { InjectedAnomaly } from "../../shared/types";

export interface Block {
  index: number;
  imu: number[];
  hr: number[];
  temp: number | null;
  truth: InjectedAnomaly[];
}

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

export class DogStream {
  readonly injections: ActiveInjection[] = [];
  private readonly samples: number;
  private readonly temperature: TemperatureSeries;
  private tempIndex = -1;
  private tempValue = 0;

  private readonly hrBlocks: number[][] | null;

  constructor(readonly dogId: string, private readonly imu: Float32Array, private readonly hr: number[],
    opts: { tempKey?: string; hrBreaks?: number[] } = {}) {
    this.samples = Math.floor(imu.length / IMU_CHANNELS);
    if (this.samples < BLOCK_SAMPLES) throw new Error(`${dogId}: la señal IMU tiene menos de un bloque.`);
    this.temperature = new TemperatureSeries(opts.tempKey ?? dogId);
    this.hrBlocks = opts.hrBreaks ? hrBlocks(hr, opts.hrBreaks) : null;
  }

  get temperatureStats() {
    return this.temperature.stats();
  }

  /** Normal signals of block k (without injections). Blocks must be requested in increasing order (temperature is a process). */
  normal(k: number): { imu: number[]; hr: number[]; temp: number } {
    const imu = new Array<number>(BLOCK_SAMPLES * IMU_CHANNELS);
    let s = (k * BLOCK_SAMPLES) % this.samples;
    for (let i = 0; i < BLOCK_SAMPLES; i++, s = (s + 1) % this.samples) {
      for (let c = 0; c < IMU_CHANNELS; c++) imu[i * IMU_CHANNELS + c] = round5(this.imu[s * IMU_CHANNELS + c]);
    }
    let hr: number[] = [];
    if (this.hrBlocks) hr = [...this.hrBlocks[k % this.hrBlocks.length]];
    else for (let i = 0; i < BLOCK_SECONDS; i++) hr.push(this.hr[(k * BLOCK_SECONDS + i) % this.hr.length]);
    if (k < this.tempIndex) throw new Error(`${this.dogId}: bloque ${k} pedido después del ${this.tempIndex}.`);
    while (this.tempIndex < k) {
      this.tempValue = this.temperature.next();
      this.tempIndex++;
    }
    return { imu, hr, temp: this.tempValue };
  }

  block(k: number): Block {
    const { signals, truth } = applyInjections(this.normal(k), this.injections, k);
    return {
      index: k,
      imu: truth.some((t) => t.type === "activity_drop" || t.type === "immobility") ? signals.imu.map(round5) : signals.imu,
      hr: signals.hr.map((v) => Math.round(v * 10) / 10),
      temp: signals.temp == null ? null : Math.round(signals.temp * 100) / 100,
      truth,
    };
  }
}

/** Blocks of up to 10 heart-rate values that never cross a break; the last one of the series is always short. */
export function hrBlocks(values: number[], breaks: number[]): number[][] {
  const starts = [0, ...breaks.filter((b) => b > 0 && b < values.length).sort((a, b) => a - b), values.length];
  const out: number[][] = [];
  for (let r = 0; r + 1 < starts.length; r++) {
    for (let i = starts[r]; i < starts[r + 1]; i += BLOCK_SECONDS) out.push(values.slice(i, Math.min(i + BLOCK_SECONDS, starts[r + 1])));
  }
  const last = out[out.length - 1];
  if (last.length === BLOCK_SECONDS && values.length > 1) last.pop();
  return out;
}
