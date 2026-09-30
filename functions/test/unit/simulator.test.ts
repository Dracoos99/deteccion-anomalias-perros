// Starting the simulator on Cloud Run Jobs from a run created in the panel.
import { describe, expect, it } from "vitest";
import { launchJob, shouldLaunch } from "../../src/simulator";

describe("simulator on Cloud Run Jobs", () => {
  it("launches only for runs waiting for a worker that nobody launched yet", () => {
    expect(shouldLaunch({ state: "running", worker: null, cloudJob: null })).toBe(true);
    expect(shouldLaunch({ state: "paused", worker: null })).toBe(true);
    expect(shouldLaunch({ state: "running", worker: { id: "cli", host: "x", heartbeatAt: null } })).toBe(false);
    expect(shouldLaunch({ state: "running", worker: null, cloudJob: { job: "simulator", requestedAt: null } })).toBe(false);
    expect(shouldLaunch({ state: "stopped", worker: null })).toBe(false);
    expect(shouldLaunch(undefined)).toBe(false);
  });

  it("runs the job with the run id as arguments, authenticated with the service account", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ name: "projects/p/locations/us-central1/operations/op1" }));
    }) as typeof fetch;
    expect(await launchJob("p", "us-central1", "simulator", "run42", async () => "tok", ok)).toBe("projects/p/locations/us-central1/operations/op1");
    expect(calls[0].url).toBe("https://run.googleapis.com/v2/projects/p/locations/us-central1/jobs/simulator:run");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ overrides: { containerOverrides: [{ args: ["job", "--run", "run42"] }] } });
    const denied = (async () => new Response("PERMISSION_DENIED", { status: 403 })) as typeof fetch;
    await expect(launchJob("p", "us-central1", "simulator", "run42", async () => "tok", denied)).rejects.toThrow(/403/);
  });
});
