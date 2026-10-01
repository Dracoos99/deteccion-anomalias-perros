import { useEffect, useState } from "react";
import { collection, doc, limit, onSnapshot, orderBy, query, where, type Query, type Timestamp } from "firebase/firestore";
import {
  DEFAULT_FUSION_CONFIG, type AlertDoc, type CsvUploadDoc, type DogDoc, type FusionConfig, type ModelVersionDoc, type ResultDoc, type SimulatorRunDoc,
  type UserDoc,
} from "@shared/types";
import type { TrendDayDoc, TrendTier, TrendTierDoc } from "@shared/trends";
import { db } from "../firebase";

export type Dog = DogDoc<Timestamp> & { id: string };
/** Owners see their dogs; an admin sees every dog, so the owner screens work for the demo with the same account. */
export type DogsScope = { kind: "owner"; uid: string } | { kind: "all" };

interface Live<T> { data: T; loading: boolean; error: string | null }
export type Fusion = Omit<FusionConfig, "updatedBy" | "updatedAt">;

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

/** Latest alerts, newest first (screen 7). Owners filter by ownerId (index alerts: ownerId, createdAt). */
export function useAlerts(scope: DogsScope, max = 50): Live<Alert[]> {
  const key = scope.kind === "all" ? "all" : `owner:${scope.uid}`;
  const [state, setState] = useState<Live<Alert[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    setState({ data: [], loading: true, error: null });
    const alerts = collection(db, "alerts");
    const q = scope.kind === "owner"
      ? query(alerts, where("ownerId", "==", scope.uid), orderBy("createdAt", "desc"), limit(max))
      : query(alerts, orderBy("createdAt", "desc"), limit(max));
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => ({ id: d.id, ...(d.data() as AlertDoc<Timestamp>) })), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, max]);
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
  const [state, setState] = useState<Live<TrendDayDoc<Timestamp>[]>>({ data: [], loading: true, error: null });
  useEffect(() => {
    if (!dogId || !fromDay) { setState({ data: [], loading: !fromDay && !!dogId, error: null }); return; }
    setState((s) => ({ ...s, loading: true }));
    const trends = collection(db, "trends");
    const q = viewer.isAdmin
      ? query(trends, where("dogId", "==", dogId), where("day", ">=", fromDay))
      : query(trends, where("ownerId", "==", viewer.uid), where("dogId", "==", dogId), where("day", ">=", fromDay));
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => d.data() as TrendDayDoc<Timestamp>), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err.message }));
  }, [dogId, viewer.uid, viewer.isAdmin, fromDay]);
  return state;
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

/** Documents of a finer trend tier that start in [fromMs, toMs] (no upper bound: up to now), live.
 * tier null: nothing to read. */
export function useTierDocs(tier: TrendTier | null, dogId: string | undefined, viewer: Viewer, fromMs: number | null,
  toMs: number | null = null): Live<TrendTierDoc<Timestamp>[]> {
  const [state, setState] = useState<Live<TrendTierDoc<Timestamp>[]>>({ data: [], loading: !!tier, error: null });
  const coll = tier?.collection ?? null;
  useEffect(() => {
    if (!coll || !dogId || fromMs == null) { setState({ data: [], loading: !!coll && !!dogId && fromMs == null, error: null }); return; }
    setState((s) => ({ ...s, loading: true }));
    const ref = collection(db, coll);
    const range = [where("startMs", ">=", fromMs), ...(toMs != null ? [where("startMs", "<=", toMs)] : [])];
    const q = viewer.isAdmin
      ? query(ref, where("dogId", "==", dogId), ...range)
      : query(ref, where("ownerId", "==", viewer.uid), where("dogId", "==", dogId), ...range);
    return onSnapshot(q,
      (snap) => setState({ data: snap.docs.map((d) => d.data() as TrendTierDoc<Timestamp>), loading: false, error: null }),
      (err) => setState({ data: [], loading: false, error: err.message }));
  }, [coll, dogId, viewer.uid, viewer.isAdmin, fromMs, toMs]);
  return state;
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
