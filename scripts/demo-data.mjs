// Demo data shared by seed-emulator.mjs (emulators) and bootstrap-prod.mjs (real project).
// Every person and dog here is fictitious: never the authors or the advisor.
import { Timestamp } from "firebase-admin/firestore";
import fs from "node:fs";

export const SCHEMA_VERSION = 1;

export const USERS = [
  { uid: "lucia-paredes", email: "lucia.paredes@example.com", displayName: "Lucía Paredes", role: "owner" },
  { uid: "martin-quispe", email: "martin.quispe@example.com", displayName: "Martín Quispe", role: "owner" },
  { uid: "diego-rojas", email: "diego.rojas@example.com", displayName: "Diego Rojas", role: "owner" },
  { uid: "jorge-rios", email: "jorge.rios@example.com", displayName: "Jorge Ríos", role: "owner" },
  { uid: "admin-demo", email: "admin@example.com", displayName: "Equipo de investigación", role: "admin" },
];

// One source per signal. IMU subjects are Vehkaoja DogIDs, HR subjects are Invoxia dogs; temperature is synthetic.
const src = (imu, hr) => ({
  imu: { datasetId: "vehkaoja2022", subjectId: imu },
  hr: { datasetId: "invoxia2023", subjectId: hr },
  temp: { datasetId: "synthetic", subjectId: null },
});
// Ten dogs so a single run can reach the maximum. Subjects with the longest recordings (≥ 53 min of IMU,
// ≥ 2.6 h of heart rate) so a 30-minute run does not loop. No vet accounts or vetIds since.
export const DOGS = [
  { id: "toby", name: "Toby", sex: "male", breed: "Labrador retriever", weightKg: 29.5, birthDate: "2021-03-14", ownerId: "lucia-paredes", source: src("23", "30") },
  { id: "luna", name: "Luna", sex: "female", breed: "Mestiza", weightKg: 14.2, birthDate: "2019-08-02", ownerId: "lucia-paredes", source: src("16", "8") },
  { id: "rocky", name: "Rocky", sex: "male", breed: "Beagle", weightKg: 12.8, birthDate: "2017-11-20", ownerId: "lucia-paredes", source: src("29", "0") },
  { id: "bruno", name: "Bruno", sex: "male", breed: "Golden retriever", weightKg: 31.0, birthDate: "2020-01-25", ownerId: "martin-quispe", source: src("74", "24") },
  { id: "canela", name: "Canela", sex: "female", breed: "Cocker spaniel", weightKg: 13.5, birthDate: "2018-06-11", ownerId: "martin-quispe", source: src("39", "11") },
  { id: "max", name: "Max", sex: "male", breed: "Border collie", weightKg: 19.0, birthDate: "2019-10-03", ownerId: "diego-rojas", source: src("47", "10") },
  { id: "nala", name: "Nala", sex: "female", breed: "Mestiza", weightKg: 16.4, birthDate: "2021-12-19", ownerId: "diego-rojas", source: src("26", "9") },
  { id: "kira", name: "Kira", sex: "female", breed: "Pastor alemán", weightKg: 27.0, birthDate: "2022-05-09", ownerId: "jorge-rios", source: src("30", "12") },
  { id: "simba", name: "Simba", sex: "male", breed: "Pastor belga", weightKg: 28.2, birthDate: "2020-07-30", ownerId: "jorge-rios", source: src("41", "18") },
  { id: "coco", name: "Coco", sex: "male", breed: "Schnauzer", weightKg: 15.1, birthDate: "2016-04-08", ownerId: "jorge-rios", source: src("27", "13") },
];

// Same values as shared/types.ts#DEFAULT_FUSION_CONFIG; kept literal so these scripts have no TS build step.
export const FUSION = {
  weights: { b: 0.4, p: 0.4, t: 0.2 }, alertThreshold: 60, levels: { green: 80, amber: 60 }, consecutiveCritical: 2,
  hrRange: [100, 150], tempRange: [37.7, 39.5], tempMaxDeviation: 1.0, baselineSigma: 2,
  prefilter: { hrMin: 20, hrMax: 300, tempMin: 30, tempMax: 45 },
  activity: { thresholdG: 0.1129, timeConstantS: 1200 }, hrAverageS: 60, novelty: { timeConstantS: 300, fullScaleRate: 0.5 },
  episodeGapS: 60, statusMinIntervalS: 10,
};

// modelVersions/{version} from the exported bundles, with their real metrics: behavior/ is written by
// ml/src/train_behavior.py and physio/ by ml/src/train_physio.py and physio_tradeoff.py.
export function modelVersionDocs() {
  return [["behavior", "behavior"], ["physiological", "physio"]].flatMap(([kind, dir]) => {
    const file = new URL(`../functions/models/${dir}/metadata.json`, import.meta.url);
    if (!fs.existsSync(file)) return [];
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    return [{ id: m.version, doc: { kind, version: m.version, architecture: m.architecture, bundlePath: `functions/models/${dir}`,
      trainingData: m.trainingData, metrics: m.metrics, active: true, trainedAt: Timestamp.fromDate(new Date(m.trainedAt)), schemaVersion: SCHEMA_VERSION } }];
  });
}
