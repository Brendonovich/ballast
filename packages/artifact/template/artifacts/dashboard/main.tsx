import { render } from "solid-js/web";
import { Effect } from "effect";
import { createArtifact } from "@ballast/artifact";
import { createQuery, createStream } from "@ballast/artifact/solid";
import { DashboardApi } from "../../src/api.ts";

const style = `
  :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b1020; color: #e6edf7; }
  body { margin: 0; }
  .dashboard { max-width: 720px; margin: 0 auto; padding: 32px; }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  h1 { margin: 0 0 6px; }
  p { color: #8fa3c4; }
  .card { background: #11182b; border: 1px solid #26324a; border-radius: 16px; padding: 20px; margin-top: 20px; }
  strong { display: block; font-size: 48px; margin-top: 8px; font-variant-numeric: tabular-nums; }
  button { background: #2456d6; color: white; border: 1px solid #4c7dff; border-radius: 10px; padding: 10px 16px; font: inherit; cursor: pointer; }
`;

export default createArtifact(DashboardApi, (client, root) => {
  const [snapshot, { refetch }] = createQuery(() => client.api.Snapshot());
  const live = createStream(() => client.api.Events(), { limit: 20 });

  const reset = () => {
    void Effect.runPromise(client.api.ResetCounters()).then(() => refetch());
  };

  const current = () => live()[live().length - 1] ?? snapshot();

  return render(
    () => (
      <main class="dashboard">
        <style>{style}</style>
        <header>
          <div>
            <h1>Stream dashboard</h1>
            <p>Replace the heartbeat timer with a real project event.</p>
          </div>
          <button type="button" onClick={reset}>Reset counters</button>
        </header>
        <section class="card">
          <span>Scene switches</span>
          <strong>{current()?.sceneSwitches ?? 0}</strong>
        </section>
      </main>
    ),
    root,
  );
});
