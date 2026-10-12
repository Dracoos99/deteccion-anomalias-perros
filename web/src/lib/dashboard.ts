/* Inicio as a dashboard: which bucket each dog is in, the four figures of the top bar and the toolbar's
   filters. Pure, so the figures and the cards always agree. */
import type { Level } from "@shared/types";

export type DogFilter = "all" | "alert" | "nodata";
export type DogBucket = "nodata" | "alert" | "normal" | "learning";

export interface DogView {
  id: string;
  name: string;
  hasData: boolean;
  level: Level | null;
  learning: boolean;
  stale: boolean;
  sensorOff: boolean;
  openAlert: boolean;
}

/** A dog without data, with old data or with the collar off is «Sin datos», never «Todo normal»; one with a new alert
 * or a level of «Atención» or «Revisar» is «En alerta»; one still learning its normal pattern is neither. */
export function bucketOf(d: DogView): DogBucket {
  if (!d.hasData || d.stale || d.sensorOff) return "nodata";
  if (d.openAlert) return "alert";
  if (d.learning) return "learning";
  if (d.level === "amber" || d.level === "red") return "alert";
  return "normal";
}

export interface Kpis { total: number; normal: number; alerts: number; nodata: number }

/** The four figures: every dog, those in «Todo normal», the new alerts (the same count as the badge of Alertas) and the
 * dogs without recent data. */
export function dashboardKpis(dogs: DogView[], activeAlerts: number): Kpis {
  const buckets = dogs.map(bucketOf);
  return {
    total: dogs.length,
    normal: buckets.filter((b) => b === "normal").length,
    alerts: activeAlerts,
    nodata: buckets.filter((b) => b === "nodata").length,
  };
}

export function matchesFilter(d: DogView, filter: DogFilter): boolean {
  if (filter === "all") return true;
  return bucketOf(d) === filter;
}

/** Search by name, ignoring case and accents («Ñuño» is found with «nuno»). */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es");
export function matchesSearch(name: string, query: string): boolean {
  const q = fold(query.trim());
  return !q || fold(name).includes(q);
}
