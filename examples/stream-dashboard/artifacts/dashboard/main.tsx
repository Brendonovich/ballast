import { createEffect, For, onCleanup, Show } from "solid-js";
import { render } from "solid-js/web";
import { Effect } from "effect";
import { createArtifact } from "@ballast/artifact";
import { createQuery, createStream } from "@ballast/artifact/solid";
import { DashboardApi } from "../../src/api.ts";

const style = `
  :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; background: #0b1020; color: #e6edf7; }
  body { margin: 0; }
  .dashboard { max-width: 880px; margin: 0 auto; padding: 32px; }
  header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  h1 { margin: 0 0 6px; }
  p { color: #8fa3c4; }
  .stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 20px 0; }
  .card { background: #11182b; border: 1px solid #26324a; border-radius: 16px; padding: 20px; }
  .stats strong { display: block; font-size: 40px; margin-top: 8px; font-variant-numeric: tabular-nums; }
  button { background: #2456d6; color: white; border: 1px solid #4c7dff; border-radius: 10px; padding: 10px 16px; font: inherit; cursor: pointer; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li { display: grid; grid-template-columns: 70px 1fr auto; gap: 10px; padding: 10px 12px; border-radius: 10px; background: #0d1425; border: 1px solid #26324a; }
  code { color: #9fb7ff; }
  time { color: #8fa3c4; font-variant-numeric: tabular-nums; }
`;

export default createArtifact(DashboardApi, (client, root) => {
  const [snapshot, { refetch }] = createQuery(() => client.api.Snapshot());
  const live = createStream(() => client.api.Chat(), { limit: 50 });

  // Counters change in the worker; poll the snapshot so the cards stay live.
  createEffect(() => {
    const timer = setInterval(() => refetch(), 1_000);
    onCleanup(() => clearInterval(timer));
  });

  const reset = () => {
    void Effect.runPromise(client.api.ResetCounters()).then(() => refetch());
  };

  const events = () => {
    const liveEvents = [...live()].reverse();
    return liveEvents.length > 0 ? liveEvents : (snapshot()?.events ?? []);
  };

  return render(
    () => (
      <main class="dashboard">
        <style>{style}</style>
        <header>
          <div>
            <h1>Stream dashboard</h1>
            <p>Fake chat history is queried and watched over RPC; ticks drive the scene counter.</p>
          </div>
          <button type="button" onClick={reset}>
            Reset counters
          </button>
        </header>

        <section class="stats">
          <article class="card">
            <span>Scene switches</span>
            <strong>{snapshot()?.sceneSwitches ?? 0}</strong>
          </article>
          <article class="card">
            <span>Messages</span>
            <strong>{snapshot()?.messages ?? 0}</strong>
          </article>
        </section>

        <section class="card">
          <h2>Event log</h2>
          <Show when={events().length > 0} fallback={<p>No events yet.</p>}>
            <ul>
              <For each={events()}>
                {(event) => (
                  <li>
                    <code>{event.kind}</code>
                    <span>{event.text}</span>
                    <time>{new Date(event.at).toLocaleTimeString()}</time>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </main>
    ),
    root,
  );
});
