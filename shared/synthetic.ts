/**
 * Deterministic synthetic signals for the simulator. No public canine temperature series exists,
 * so temperature is generated: an Ornstein-Uhlenbeck process around a per-dog mean. Parameters are simulation
 * choices anchored on Dorn et al. (2024): mean 38.6 °C and reference range 37.7-39.5 °C. They are not data.
 */

/** 32-bit FNV-1a hash of a string, used to derive per-dog seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast and reproducible PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws (Box-Muller) from a uniform PRNG. */
export function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
}

export const TEMPERATURE_MODEL = {
  populationMean: 38.6,  // Dorn et al. (2024)
  dogMeanSd: 0.2,        // spread of per-dog means (simulation choice)
  dogMeanClamp: [38.1, 39.1] as [number, number],
  stationarySd: 0.15,    // within-dog variability (simulation choice)
  correlationS: 1800,    // 30 min memory of the process (simulation choice)
};

/** One temperature value per 10 s block, reproducible from (dogKey, seed). */
export class TemperatureSeries {
  readonly mean: number;
  private value: number;
  private readonly phi: number;
  private readonly noiseSd: number;
  private readonly normal: () => number;

  constructor(dogKey: string, seed = 0, blockSeconds = 10) {
    const m = TEMPERATURE_MODEL;
    this.normal = gaussian(mulberry32(hashString(`${dogKey}:${seed}`)));
    const raw = m.populationMean + m.dogMeanSd * this.normal();
    this.mean = Math.min(m.dogMeanClamp[1], Math.max(m.dogMeanClamp[0], raw));
    this.phi = Math.exp(-blockSeconds / m.correlationS);
    this.noiseSd = m.stationarySd * Math.sqrt(1 - this.phi * this.phi);
    this.value = this.mean + m.stationarySd * this.normal();
  }

  /** Next block value in °C, rounded to 2 decimals. */
  next(): number {
    this.value = this.mean + this.phi * (this.value - this.mean) + this.noiseSd * this.normal();
    return Math.round(this.value * 100) / 100;
  }

  /** Stationary mean and standard deviation of the process (used as the dog's temperature baseline). */
  stats(): { mean: number; std: number } {
    return { mean: this.mean, std: TEMPERATURE_MODEL.stationarySd };
  }
}
