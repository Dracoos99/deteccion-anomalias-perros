/* An alert in a list (Alertas and the dog's alert history) and its review state, also shown in the alert detail. */
import { Link } from "react-router-dom";
import { Icon, LEVELS, LevelTag, levelVars } from "./ui";
import type { Alert } from "../data/hooks";
import { simulatedTime } from "../lib/live";
import { aheadTag, alertGoing, alertStartMs, alertTitle, durationText, whenText, type DataSource } from "../lib/plain";

/** Review state of an alert: "Nueva" until the owner marks it as reviewed. Not "Sin revisar", which next to the
 * «Revisar» level read as «Revisar · Sin revisar». */
export function ReviewTag({ open }: { open: boolean }) {
  return <span className={open ? "tag tag-open" : "tag tag-done"}>{open ? "Nueva" : "Revisada"}</span>;
}

/** One alert (screen 7): the level in an icon, the dog and whether it was reviewed, the title in plain language, when
 * and for how long, its level (colour, icon and text). A new alert is a card; a reviewed one sinks into the page.
 * `dogName` is the dog's current name (the alert keeps the one it had when it opened). The level
 * is the highest the alert reached, and the time says when it is simulated time, or for a CSV the hour of
 * the file. `featured` is the first new alert of
 * the list, the protagonist of Alertas: a larger card with the colour of its level and «Ver detalle» as the action. */
export function AlertItem({ alert, showDog = true, dogName, source, featured = false }: { alert: Alert; showDog?: boolean; dogName?: string; source?: DataSource; featured?: boolean }) {
  const open = alert.status === "open";
  const start = alertStartMs(alert), end = alert.endedAt?.toMillis?.();
  const simulated = simulatedTime(start, alert.createdAt?.toMillis?.(), Date.now());
  const when = [start ? `${whenText(start)}${simulated ? ` (${aheadTag(source)})` : ""}` : null, end ? `duró ${durationText(end - start)}` : null].filter(Boolean).join(" · ");
  return (
    <li>
      <Link className="panel alert-item" to={`/alertas/${alert.id}`} data-open={open} data-featured={featured ? "true" : undefined} style={levelVars(alert.severity)}>
        <span className="alert-item-icon" aria-hidden="true"><Icon name={LEVELS[alert.severity].icon} size={featured ? 28 : 20} /></span>
        <div className="alert-item-body">
          {showDog && (
            <div className="alert-item-top">
              <span className="alert-item-dog">{dogName ?? alert.dogName}</span>
              <ReviewTag open={open} />
            </div>
          )}
          <span className="alert-item-title">{alertTitle(alert.reasons, alert.titleCode, alertGoing(alert))}</span>
          <div className="alert-item-meta">
            <span className="alert-item-when">{when}</span>
            <LevelTag level={alert.severity} iconSize={12} prefix="Nivel más alto" />
            {!showDog && <ReviewTag open={open} />}
          </div>
          <span className="alert-item-more">Ver detalle <Icon name="chevron-right" size={14} /></span>
        </div>
      </Link>
    </li>
  );
}
