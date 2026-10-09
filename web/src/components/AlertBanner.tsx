import { Link } from "react-router-dom";
import type { Level } from "@shared/types";
import type { Alert } from "../data/hooks";
import { simulatedTime } from "../lib/live";
import { aheadTag, alertGoing, alertStartMs, alertTitle, whenPhrase, type DataSource } from "../lib/plain";
import { Icon, LEVELS, useNow } from "./ui";

/** The open alert of a dog as one row of the colour of its level, with a link to the alert: on its Inicio card and at
 * the top of its detail. An episode that already ended says so, so «Todo normal» and the alert do not read as two answers
 *. `isNew` eases it in when it opens while the owner looks. The colour is
 * the highest level the alert reached; when the dog's level shown above (`dogLevel`) is another, the row says so in
 * words. `data-ended` marks an alert whose episode ended, for the styles. A time ahead of the clock is
 * «tiempo simulado» or, for a CSV, «hora del archivo» (`source`, the dog's dogs.status.lastSource). 
 * the title is in the present only while the variable that names the alert is still out of its band (`present`). */
export function AlertBanner({ alert, isNew = false, dogLevel = null, source, present = true }: { alert: Alert; isNew?: boolean; dogLevel?: Level | null; source?: DataSource; present?: boolean }) {
  const now = useNow(30_000);
  const A = LEVELS[alert.severity];
  const start = alertStartMs(alert);
  const lead = alert.endedAt ? "Alerta nueva (ya pasó):" : "Alerta nueva:";
  const simulated = simulatedTime(start, alert.createdAt?.toMillis?.(), now);
  const otherLevel = !!dogLevel && dogLevel !== alert.severity;
  return (
    <Link className={isNew ? "alert-banner appear" : "alert-banner"} data-level={alert.severity} data-ended={alert.endedAt ? "true" : undefined} to={`/alertas/${alert.id}`}>
      <Icon name={A.icon} size={18} style={{ color: A.color }} />
      <span>
        <strong>{lead}</strong> {alertTitle(alert.reasons, alert.titleCode, present && alertGoing(alert, now)).toLowerCase()}
        {!otherLevel && <span className="sr-only">. Nivel más alto de la alerta: {A.text}</span>}
        <span className="alert-banner-when"> · {whenPhrase(start)}{simulated ? ` (${aheadTag(source)})` : ""}{otherLevel ? ` · nivel más alto de la alerta: «${A.text}»` : ""}</span>
      </span>
      <Icon name="chevron-right" size={16} />
    </Link>
  );
}
