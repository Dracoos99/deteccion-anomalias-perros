import { useEffect, useState } from "react";
import { Timestamp, collection, doc, limit, onSnapshot, orderBy, query, where, type Query } from "firebase/firestore";
import {
  DEFAULT_FUSION_CONFIG, type AlertDoc, type CsvUploadDoc, type DogDoc, type FusionConfig, type ModelVersionDoc, type ResultDoc, type SimulatorRunDoc, type SimulatorTruthDoc, type ExpertReviewItem,
  type UserDoc,
} from "@shared/types";
import type { TrendDayDoc, TrendTier, TrendTierDoc } from "@shared/trends";
import { db } from "../firebase";
import { NO_MARKS, type ClearMarks } from "../lib/bulkAlerts";

export type Dog = DogDoc<Timestamp> & { id: string };
/** Owners see their dogs; an admin sees every dog, so the owner screens work for the demo with the same account. */
export type DogsScope = { kind: "owner"; uid: string } | { kind: "all" };

interface Live<T> { data: T; loading: boolean; error: string | null }
export type Fusion = Omit<FusionConfig, "updatedBy" | "updatedAt">;

/** State of a query that changes with its inputs. `key` names the query whose snapshot is in `data`; `base` the series
 * it belongs to (the same dog and collection). */
type Keyed<T> = Live<T> & { key: string | null; base: string | null };

/** Loading until the snapshot of the current query arrives, so nothing reads "Sin datos" in between. The same series
 * with a moved window keeps its data while it reloads; another series starts empty. */
function current<T>(state: Keyed<T[]>, key: string, base: string): Live<T[]> {
  if (state.key === key) return state;
  return { data: state.base === base ? state.data : [], loading: true, error: null };
}

/** Weights and thresholds live in config/fusion. Until the doc exists the defaults apply. */
export function useFusionConfig(): Live<Fusion> {
  const [state, setState] = useState<Live<Fusion>>({ data: DEFAULT_FUSION_CONFIG, loading: true, error: null });
  useEffect(() => onSnapshot(doc(db, "config", "fusion"),
    (snap) => setState({ data: { ...DEFAULT_FUSION_CONFIG, ...(snap.data() as Partial<FusionConfig> | undefined) }, loading: false, error: null }),
    (err) => setState((s) => ({ ...s, loading: false, error: err.message }))), []);
  return state;
}

function dogsQuery(scope: DogsScope): Query {
  const dogs = collection(db, "dogs");
  // Queries must match firestore.rules: owners filter by ownerId, admins read all.
  // Only the owner query filters `active` on the server: it has its composite index in firestore.indexes.json.
  if (scope.kind === "owner") return query(dogs, where("ownerId", "==", scope.uid), where("active", "==", true));
  return query(dogs);
}

export function useDogs(scope: DogsScope): Live<Dog[]> {
  const key = scope.kind === "all" ? "all" : `${scope.kind}:${scope.uid}`;
  const [state, setState] = useState<Live<Dog[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    setState({ data: [], loading: true, error: null });
    return onSnapshot(dogsQuery(scope),
      (snap) => setState({
        data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as DogDoc<Timestamp>) })).filter((d) => d.active),
        loading: false, error: null,
      }),
      (err) => setState({ data: [], loading: false, error: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state;
}

export type Run = SimulatorRunDoc<Timestamp> & { id: string };

/** Latest simulator runs. */
export function useRuns(max = 10): Live<Run[]> {
  const [state, setState] = useState<Live<Run[]>>({ data: [], loading: true, error: null });
  useEffect(() => onSnapshot(query(collection(db, "simulatorRuns"), orderBy("createdAt", "desc"), limit(max)),
    (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as SimulatorRunDoc<Timestamp>) })), loading: false, error: null }),
    (err) => setState({ data: [], loading: false, error: err.message })), [max]);
  return state;
}

export type ModelVersion = ModelVersionDoc<Timestamp> & { id: string };

/** Active model versions. */
export function useActiveModels(): Live<ModelVersion[]> {
  const [state, setState] = useState<Live<ModelVersion[]>>({ data: [], loading: true, error: null });
  useEffect(() => onSnapshot(query(collection(db, "modelVersions"), where("active", "==", true)),
    (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as ModelVersionDoc<Timestamp>) })), loading: false, error: null }),
    (err) => setState({ data: [], loading: false, error: err.message })), []);
  return state;
}

export type Alert = AlertDoc<Timestamp> & { id: string };

/** Latest alerts, newest first (screen 7). Owners filter by ownerId (index alerts: ownerId, createdAt). `since`: only
 * alerts created after it; undefined waits until it is known. */
export function useAlerts(scope: DogsScope, max = 50, since: number | null | undefined = null): Live<Alert[]> {
  const base = scope.kind === "all" ? "all" : `owner:${scope.uid}`, key = `${base}|${max}|${since}`;
  const [state, setState] = useState<Keyed<Alert[]>>({ data: [], loading: true, error: null, key: null, base: null });
  useEffect(() => {
    if (since === undefined) return;
    const alerts = collection(db, "alerts");
    const after = since != null ? [where("createdAt", ">", Timestamp.fromMillis(since))] : [];
    const q = scope.kind === "owner"
      ? query(alerts, where("ownerId", "==", scope.uid), ...after, orderBy("createdAt", "desc"), limit(max))
      : query(alerts, ...after, orderBy("createdAt", "desc"), limit(max));
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as AlertDoc<Timestamp>) })), loading: false, error: null, key, base }),
      (err) => setState({ data: [], loading: false, error: err.message, key, base }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (since === undefined) return { data: [], loading: true, error: null };
  // Asking for more, or clearing the list, keeps the alerts already loaded while the new query arrives.
  return current(state, key, base);
}

/** When the person cleared their Alertas list, in epoch ms; null until the profile arrives. `marks` counts a
 * clear still on its way with the local estimate of the server time, so the list empties at once; `since`, for the
 * query, keeps the previous mark until the server confirms the new one, so the query changes only once. */
export function useClearMarks(uid: string): { marks: ClearMarks; since: number | null } | null {
  const [state, setState] = useState<{ marks: ClearMarks; since: number | null } | null>(null);
  useEffect(() => onSnapshot(doc(db, "users", uid),
    (snap) => {
      const cleared = (snap.data({ serverTimestamps: "estimate" }) as UserDoc<Timestamp> | undefined)?.alertsCleared;
      const confirmed = (snap.data({ serverTimestamps: "previous" }) as UserDoc<Timestamp> | undefined)?.alertsCleared;
      const byDog: Record<string, number> = {};
      for (const [dogId, t] of Object.entries(cleared?.byDog ?? {})) if (t?.toMillis) byDog[dogId] = t.toMillis();
      setState({ marks: { all: cleared?.all?.toMillis?.() ?? null, byDog }, since: confirmed?.all?.toMillis?.() ?? null });
    },
    () => setState({ marks: NO_MARKS, since: null })), [uid]);
  return state;
}

// ── Phase 3: one dog, its trends and its alerts ──────────────────────────────────────────────────

/** Firestore queries must carry the owner filter for the rules to accept them; an admin reads without it. */
export type Viewer = { uid: string; isAdmin: boolean };

export function useDog(dogId: string | undefined): Live<Dog | null> {
  const [state, setState] = useState<Live<Dog | null>>({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!dogId) { setState({ data: null, loading: false, error: null }); return; }
    setState({ data: null, loading: true, error: null });
    return onSnapshot(doc(db, "dogs", dogId),
      (snap) => setState({ data: snap.exists() ? { id: snap.id, ...(snap.data() as DogDoc<Timestamp>) } : null, loading: false, error: null }),
      (err) => setState({ data: null, loading: false, error: err.message }));
  }, [dogId]);
  return state;
}

/** Trend day documents of a dog from `fromDay` (YYYY-MM-DD) on, live. */
export function useTrendDocs(dogId: string | undefined, viewer: Viewer, fromDay: string | null): Live<TrendDayDoc<Timestamp>[]> {
  const [state, setState] = useState<Keyed<TrendDayDoc<Timestamp>[]>>({ data: [], loading: true, error: null, key: null, base: null });
  const base = `trends|${dogId}|${viewer.uid}|${viewer.isAdmin}`, key = `${base}|${fromDay}`;
  useEffect(() => {
    if (!dogId || !fromDay) return;
    const trends = collection(db, "trends");
    const q = viewer.isAdmin
      ? query(trends, where("dogId", "==", dogId), where("day", ">=", fromDay))
      : query(trends, where("ownerId", "==", viewer.uid), where("dogId", "==", dogId), where("day", ">=", fromDay));
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => d.data() as TrendDayDoc<Timestamp>), loading: false, error: null, key, base }),
      (err) => setState({ data: [], loading: false, error: err.message, key, base }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!dogId || !fromDay) return { data: [], loading: !fromDay && !!dogId, error: null };
  return current(state, key, base);
}

export type Result = ResultDoc<Timestamp> & { id: string };

/** Latest results of one dog, newest first, live: the "En vivo" panel. */
export function useLiveResults(dogId: string | undefined, viewer: Viewer, max = 300): Live<Result[]> {
  const [state, setState] = useState<Live<Result[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    if (!dogId) { setState({ data: [], loading: false, error: null }); return; }
    const results = collection(db, "results");
    const q = viewer.isAdmin
      ? query(results, where("dogId", "==", dogId), orderBy("blockStart", "desc"), limit(max))
      : query(results, where("ownerId", "==", viewer.uid), where("dogId", "==", dogId), orderBy("blockStart", "desc"), limit(max));
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as ResultDoc<Timestamp>) })), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err.message }));
  }, [dogId, viewer.uid, viewer.isAdmin, max]);
  return state;
}

/** The latest results of a simulator run (all its dogs, or one), newest first, live: the run's pipeline and the
 * annotated-versus-predicted panel of /admin (indexes results: sourceRef, [dogId,] blockStart). Admin only. */
export function useRunResults(runId: string | undefined, dogId: string | null = null, max = 12): Live<Result[]> {
  const [state, setState] = useState<Live<Result[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    if (!runId) { setState({ data: [], loading: false, error: null }); return; }
    const results = collection(db, "results");
    const q = dogId
      ? query(results, where("sourceRef", "==", runId), where("dogId", "==", dogId), orderBy("blockStart", "desc"), limit(max))
      : query(results, where("sourceRef", "==", runId), orderBy("blockStart", "desc"), limit(max));
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as ResultDoc<Timestamp>) })), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err.message }));
  }, [runId, dogId, max]);
  return state;
}

export type Truth = SimulatorTruthDoc<Timestamp> & { id: string };

/** The behavior annotated from video for the latest blocks of one dog of a run, newest first, live. */
export function useRunTruth(runId: string | undefined, dogId: string | null, max = 120): Live<Truth[]> {
  const [state, setState] = useState<Live<Truth[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    if (!runId || !dogId) { setState({ data: [], loading: false, error: null }); return; }
    const q = query(collection(db, "simulatorTruth"), where("runId", "==", runId), where("dogId", "==", dogId), orderBy("blockStart", "desc"), limit(max));
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as SimulatorTruthDoc<Timestamp>) })), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err.message }));
  }, [runId, dogId, max]);
  return state;
}

export type ReviewItem = ExpertReviewItem<Timestamp> & { id: string };

/** A3: every stretch of the blind expert review, live. Admin only. */
export function useReviewItems(): Live<ReviewItem[]> {
  const [state, setState] = useState<Live<ReviewItem[]>>({ data: [], loading: true, error: null });
  useEffect(() => onSnapshot(collection(db, "expertReviews"),
    (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as ExpertReviewItem<Timestamp>) })), loading: false, error: null }),
    (err) => setState({ data: [], loading: false, error: err.message })), []);
  return state;
}

/** Documents of a finer trend tier that start in [fromMs, toMs] (no upper bound: up to now), live.
 * tier null: nothing to read. */
export function useTierDocs(tier: TrendTier | null, dogId: string | undefined, viewer: Viewer, fromMs: number | null,
  toMs: number | null = null): Live<TrendTierDoc<Timestamp>[]> {
  const [state, setState] = useState<Keyed<TrendTierDoc<Timestamp>[]>>({ data: [], loading: true, error: null, key: null, base: null });
  const coll = tier?.collection ?? null;
  const base = `${coll}|${dogId}|${viewer.uid}|${viewer.isAdmin}`, key = `${base}|${fromMs}|${toMs}`;
  useEffect(() => {
    if (!coll || !dogId || fromMs == null) return;
    const ref = collection(db, coll);
    const range = [where("startMs", ">=", fromMs), ...(toMs != null ? [where("startMs", "<=", toMs)] : [])];
    const q = viewer.isAdmin
      ? query(ref, where("dogId", "==", dogId), ...range)
      : query(ref, where("ownerId", "==", viewer.uid), where("dogId", "==", dogId), ...range);
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => d.data() as TrendTierDoc<Timestamp>), loading: false, error: null, key, base }),
      (err) => setState({ data: [], loading: false, error: err.message, key, base }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!coll || !dogId || fromMs == null) return { data: [], loading: !!coll && !!dogId && fromMs == null, error: null };
  return current(state, key, base);
}

/** Alerts of one dog, newest first. */
export function useDogAlerts(dogId: string | undefined, viewer: Viewer, max = 100): Live<Alert[]> {
  const [state, setState] = useState<Live<Alert[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    if (!dogId) { setState({ data: [], loading: false, error: null }); return; }
    const alerts = collection(db, "alerts");
    const q = viewer.isAdmin
      ? query(alerts, where("dogId", "==", dogId), orderBy("createdAt", "desc"), limit(max))
      : query(alerts, where("ownerId", "==", viewer.uid), where("dogId", "==", dogId), orderBy("createdAt", "desc"), limit(max));
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as AlertDoc<Timestamp>) })), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err.message }));
  }, [dogId, viewer.uid, viewer.isAdmin, max]);
  return state;
}

/** Open alerts of the viewer's dogs (Inicio banners), newest first. */
export function useOpenAlerts(viewer: Viewer): Live<Alert[]> {
  const [state, setState] = useState<Live<Alert[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    const alerts = collection(db, "alerts");
    const q = viewer.isAdmin
      ? query(alerts, where("status", "==", "open"), limit(100))
      : query(alerts, where("ownerId", "==", viewer.uid), where("status", "==", "open"), orderBy("createdAt", "desc"), limit(100));
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as AlertDoc<Timestamp>) })), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err.message }));
  }, [viewer.uid, viewer.isAdmin]);
  return state;
}

export function useAlert(alertId: string | undefined): Live<Alert | null> {
  const [state, setState] = useState<Live<Alert | null>>({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!alertId) { setState({ data: null, loading: false, error: null }); return; }
    return onSnapshot(doc(db, "alerts", alertId),
      (snap) => setState({ data: snap.exists() ? { id: snap.id, ...(snap.data() as AlertDoc<Timestamp>) } : null, loading: false, error: null }),
      (err) => setState({ data: null, loading: false, error: err.message }));
  }, [alertId]);
  return state;
}

// ── Phase 5: CSV uploads and the user's notification settings ────────────────────────────────────

export type CsvUpload = CsvUploadDoc<Timestamp> & { id: string };

/** Latest CSV uploads, newest first (index csvUploads: ownerId, createdAt). */
export function useCsvUploads(viewer: Viewer, max = 10): Live<CsvUpload[]> {
  const [state, setState] = useState<Live<CsvUpload[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    const uploads = collection(db, "csvUploads");
    const q = viewer.isAdmin
      ? query(uploads, orderBy("createdAt", "desc"), limit(max))
      : query(uploads, where("ownerId", "==", viewer.uid), orderBy("createdAt", "desc"), limit(max));
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as CsvUploadDoc<Timestamp>) })), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err.message }));
  }, [viewer.uid, viewer.isAdmin, max]);
  return state;
}

export function useUserProfile(uid: string | undefined): Live<UserDoc<Timestamp> | null> {
  const [state, setState] = useState<Live<UserDoc<Timestamp> | null>>({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!uid) { setState({ data: null, loading: false, error: null }); return; }
    return onSnapshot(doc(db, "users", uid),
      (snap) => setState({ data: snap.exists() ? (snap.data() as UserDoc<Timestamp>) : null, loading: false, error: null }),
      (err) => setState({ data: null, loading: false, error: err.message }));
  }, [uid]);
  return state;
}
