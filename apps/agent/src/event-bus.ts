import type { RuntimeSession } from "./runtime-session.ts";

/**
 * The agent's outbound event bus. Only the active worker generation receives
 * deliveries, so swapping generations cannot duplicate a handler.
 */
export class AgentEventBus {
  private active: RuntimeSession | undefined;

  setActive(session: RuntimeSession | undefined): void {
    this.active = session;
  }

  publish(topicKey: string, payload: unknown): void {
    this.active?.deliver(topicKey, payload);
  }
}
