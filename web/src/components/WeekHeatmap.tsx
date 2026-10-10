/* The week by hour: a day × hour heat map of the share of time in movement, from the 5-minute slots, for the
   Vista para el veterinario. A more intense colour is more movement (lighter on the dark theme, darker on paper); an hour
   without data is left empty. */
import type { TimedSlot } from "@shared/trends";
import { activeHours, hourlyGrid } from "../lib/day";
import { endSentence } from "../lib/plain";
import { fmtNum } from "./ui";

const hourText = (h: number) => (h === 0 ? "12 a. m." : h < 12 ? `${h} a. m.` : h === 12 ? "12 p. m." : `${h - 12} p. m.`);
const dayText = (ms: number) => new Date(ms).toLocaleDateString("es-PE", { weekday: "short", day: "numeric" });

export function WeekHeatmap({ slots, endMs, name }: { slots: readonly TimedSlot[]; endMs: number; name: string }) {
  const grid = hourlyGrid(slots, endMs, 7);
  if (!grid.some((r) => r.some((c) => c.moving != null))) return null;
  const top = activeHours(grid, 2);
  const summary = top.length
    ? endSentence(`${name} se movió más entre ${top.map((h) => `las ${hourText(h)} y las ${hourText((h + 1) % 24)}`).join(" y entre ")}`)
    : `${name} casi no se movió en las horas con datos.`;
  return (
    <figure className="heatmap" aria-label={`Tiempo en movimiento por hora en los últimos 7 días. ${summary}`}>
      <div className="heatmap-grid" aria-hidden="true">
        <span />
        {Array.from({ length: 24 }, (_, h) => <span key={h} className="heatmap-hour">{h % 3 === 0 ? hourText(h).replace(" a. m.", "a").replace(" p. m.", "p") : ""}</span>)}
        {grid.map((row) => (
          <div key={row[0].dayStart} className="heatmap-row">
            <span className="heatmap-day">{dayText(row[0].dayStart)}</span>
            {row.map((c) => (
              <span key={c.hour} className="heatmap-cell" data-empty={c.moving == null ? "true" : undefined}
                style={c.moving == null ? undefined : { ["--v" as string]: Math.max(0.06, Math.min(1, c.moving / 0.6)) }}
                title={c.moving == null ? `${dayText(c.dayStart)}, ${hourText(c.hour)}: sin datos` : `${dayText(c.dayStart)}, ${hourText(c.hour)}: ${fmtNum(100 * c.moving)} % en movimiento${c.hr != null ? `, ${fmtNum(c.hr)} lpm` : ""}`} />
            ))}
          </div>
        ))}
      </div>
      {/* The scale, and an empty hour drawn apart from an hour without movement. */}
      <div className="heatmap-scale" aria-hidden="true">
        <span className="heatmap-cell" data-empty="true" /> <span>Sin datos</span>
        {[0, 0.15, 0.3, 0.45, 0.6].map((v) => <span key={v} className="heatmap-cell" style={{ ["--v" as string]: Math.max(0.06, v / 0.6) }} />)}
        <span>0 % a 60 % o más en movimiento</span>
      </div>
      <figcaption className="vet-note">{summary} Cada celda es una hora; cuanto más intenso el color, más tiempo en movimiento (color pleno desde el 60 %).</figcaption>
    </figure>
  );
}
