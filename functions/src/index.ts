import { initializeApp } from "firebase-admin/app";
import { onInit, setGlobalOptions } from "firebase-functions/v2";
import { REGION } from "./config";

initializeApp();
// Cost guard while in development: cap concurrent instances per function.
setGlobalOptions({ region: REGION, maxInstances: 10 });

export { setInitialRole } from "./roles";
export { onReadingCreated } from "./readings";
// Load the behavioral model when an instance starts, not on its first block. onInit does not run while
// the CLI analyses the code at deploy or emulator start, which must finish within 10 s.
onInit(() => {
  void import("./behavior").then((m) => m.getBehaviorRunner());
  void import("./physio").then((m) => m.getPhysioRunner());
});
export { onAlertUpdated } from "./alerts";
export { onAlertCreated } from "./notify";
export { resetBaseline } from "./baseline";
export { onSimulatorRunCreated } from "./simulator";
