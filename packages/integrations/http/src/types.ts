export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export type HttpDriverBody =
  | { readonly type: "json"; readonly value: unknown }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "binary"; readonly base64: string };

export interface HttpDriverRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: HttpDriverBody;
}

export interface HttpDriverResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly url: string;
}

export interface HttpAuth {
  readonly type: "bearer" | "basic" | "header";
  readonly token?: string;
  readonly username?: string;
  readonly password?: string;
  readonly name?: string;
  readonly value?: string;
}

export interface HttpClientConfig {
  readonly slot: string;
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly auth?: HttpAuth;
  readonly allowedHosts?: ReadonlyArray<string>;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
}

export type WebhookVerification =
  | {
      readonly type: "shared-secret";
      readonly header: string;
      readonly secret: string;
    }
  | {
      readonly type: "hmac-sha256";
      readonly header: string;
      readonly secret: string;
      readonly encoding: "hex" | "base64";
      readonly prefix?: string;
      readonly timestampHeader?: string;
      readonly toleranceSeconds?: number;
    };

export interface WebhookStaticResponse {
  readonly status?: number;
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly contentType?: string;
}

export interface WebhookLocalConfig {
  readonly host?: string;
  readonly port: number;
  readonly path?: string;
}

export interface WebhookCloudConfig {
  readonly label?: string;
  readonly maxAgeMs?: number;
  readonly onStale?: "drop" | "deliver";
}

export interface WebhookDefinition {
  readonly slot: string;
  readonly hookId?: string;
  readonly transport: "local" | "cloud";
  readonly verification?: WebhookVerification;
  readonly response?: WebhookStaticResponse;
  readonly maxBodyBytes?: number;
  readonly local?: WebhookLocalConfig;
  readonly cloud?: WebhookCloudConfig;
}

export interface WebhookDelivery {
  readonly hook: string;
  readonly id: string;
  readonly source: "local" | "cloud";
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly receivedAt: number;
}

export interface WebhookStatus {
  readonly slot: string;
  readonly hookId: string;
  readonly transport: "local" | "cloud";
  readonly status: "listening" | "registered" | "error";
  readonly url?: string;
  readonly address?: string;
  readonly error?: string;
}
