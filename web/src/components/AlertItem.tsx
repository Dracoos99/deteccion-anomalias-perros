/* An alert in a list (Alertas and the dog's alert history) and its review state, also shown in the alert detail. */
import { Link } from "react-router-dom";
import { Icon, LevelTag, levelVars } from "./ui";
import type { Alert } from "../data/hooks";
import { alertStartMs, alertTitle, durationText, whenText } from "../lib/plain";

/** Review state of an alert: "Nueva" until the owner marks it as reviewed. Not "Sin revisar", which next to the
 * «Revisar» level read as «Revisar · Sin revisar». */
export function ReviewTag({ open }: { open: boolean }) {
  return <span className={open ? "tag tag-open" : "tag tag-done"}>{open ? "Nueva" : "Revisada"}</span>;
}

/** One alert (screen 7): the dog and whether it was reviewed, the title in plain language, when and for how long, its
 * level (colour, icon and text) and the left border in the level colour. `dogName` is the dog's current name (the
 * alert keeps the one it had when it opened). */
export function AlertItem({ alert, showDog = true, dogName }: { alert: Alert; showDog?: boolean; dogName?: string }) {
  const open = alert.status === "open";
  const start = alertStartMs(alert), end = alert.endedAt?.toMillis?.();
  const when = [start ? whenText(start) : null, end ? `duró ${durationText(end - start)}` : null].filter(Boolean).join(" · ");
  return (
    <li>
      <Link className="panel alert-item" to={`/alertas/${alert.id}`} data-open={open} style={levelVars(alert.severity)}>
        {showDog && (
          <div className="alert-item-top">
            <span className="kicker">{dogName ?? alert.dogName}</span>
            <ReviewTag open={open} />
          </div>
        )}
        <span className="alert-item-title">{alertTitle(alert.reasons)}</span>
        <div className="alert-item-meta">
          <span className="xs muted tabular">{when}</span>
          <LevelTag level={alert.severity} iconSize={12} />
          {!showDog && <ReviewTag open={open} />}
        </div>
        <span className="alert-item-more">Ver detalle <Icon name="chevron-right" size={13} /></span>
      </Link>
    </li>
  );
}
