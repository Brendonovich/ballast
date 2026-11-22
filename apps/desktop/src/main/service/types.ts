/** The local service contract from decision 0003 §2. */
export const SUPPORTED_AGENT_API_VERSION = 1;

export interface ServiceRegistration {
  readonly schemaVersion: 1;
  readonly apiVersion: number;
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly token: string;
  readonly pid: number;
  readonly defaultProjectId?: string;
  readonly startedAt: number;
  readonly stateDir?: string;
  readonly dataDir?: string;
}

export interface RegistrationLocation {
  readonly registration: ServiceRegistration;
  readonly file: string;
}

export interface HealthSnapshot {
  readonly ok: boolean;
  readonly apiVersion: number | null;
  readonly version: string | null;
  readonly pid: number | null;
  readonly pendingConsents: number | null;
}

export interface AdoptedService {
  readonly registration: ServiceRegistration;
  readonly file: string;
  readonly health: HealthSnapshot;
  readonly compatible: boolean;
  readonly reason: string | null;
}

export interface StageRef {
  readonly version: string;
  readonly directory: string;
}

export interface Stage extends StageRef {
  readonly entry: string;
  readonly worker: string;
  readonly web: string;
}

export interface ServiceBuild {
  readonly version: string;
  readonly directory: string;
}
