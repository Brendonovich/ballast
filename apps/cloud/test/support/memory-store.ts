import { Effect, Option } from "effect";

import type {
  CloudStoreService,
  MachineRow,
  OAuthStateRow,
  PairingCodeRow,
  ShareAuthCodeRow,
  ShareSessionRow,
  ShareSignInRow,
  ShareUserRow,
  SubscriptionOwnerRow,
  SubscriptionRow,
  TwitchAccountRow,
  UserRow,
  WebhookHookRow,
} from "../../src/store.ts";

/**
 * In-memory CloudStore for unit tests and the local Node harness. It implements
 * the same contract as the D1 store without SQL.
 */
export const makeMemoryStore = (): CloudStoreService => {
  const oauthStates = new Map<string, OAuthStateRow>();
  const users = new Map<string, UserRow>();
  const accounts = new Map<string, TwitchAccountRow>();
  const machines = new Map<string, MachineRow>();
  const pairingCodes = new Map<string, PairingCodeRow>();
  const shareSignIns = new Map<string, ShareSignInRow>();
  const shareUsers = new Map<string, ShareUserRow>();
  const shareCodes = new Map<string, ShareAuthCodeRow>();
  const shareSessions = new Map<string, ShareSessionRow>();
  const takeLive = <A extends { readonly expiresAt: number }>(map: Map<string, A>, key: string, now: number) => {
    const row = map.get(key);
    map.delete(key);
    return row === undefined || row.expiresAt <= now ? Option.none<A>() : Option.some(row);
  };
  const subscriptions = new Map<string, SubscriptionRow>();
  const owners = new Map<string, SubscriptionOwnerRow>();
  const deliveries = new Map<string, { accountId: string; receivedAt: number }>();
  const rateLimits = new Map<
    string,
    { count: number; windowStart: number; expiresAt: number }
  >();
  const hooks = new Map<string, WebhookHookRow>();

  const copyAccount = (row: TwitchAccountRow): TwitchAccountRow => structuredClone(row);
  const copySubscription = (row: SubscriptionRow): SubscriptionRow => structuredClone(row);

  return {
    insertShareSignIn: (row) => Effect.sync(() => void shareSignIns.set(row.state, { ...row })),
    takeShareSignIn: (state, now) => Effect.sync(() => takeLive(shareSignIns, state, now)),
    upsertShareUser: (row) =>
      Effect.sync(() => {
        const existing = [...shareUsers.values()].find(
          (user) => user.issuer === row.issuer && user.subject === row.subject,
        );
        const stored: ShareUserRow =
          existing === undefined
            ? { ...row }
            : { ...existing, name: row.name, username: row.username, updatedAt: row.updatedAt };
        shareUsers.set(stored.id, stored);
        return stored;
      }),
    findShareUser: (id) => Effect.sync(() => Option.fromNullishOr(shareUsers.get(id))),
    insertShareAuthCode: (row) => Effect.sync(() => void shareCodes.set(row.codeHash, { ...row })),
    takeShareAuthCode: (codeHash, now) => Effect.sync(() => takeLive(shareCodes, codeHash, now)),
    insertShareSession: (row) => Effect.sync(() => void shareSessions.set(row.id, { ...row })),
    findShareSessionByTokenHash: (tokenHash) =>
      Effect.sync(() =>
        Option.fromNullishOr([...shareSessions.values()].find((row) => row.tokenHash === tokenHash)),
      ),
    touchShareSession: (id, now) =>
      Effect.sync(() => {
        const row = shareSessions.get(id);
        if (row !== undefined) shareSessions.set(id, { ...row, lastUsedAt: now });
      }),
    deleteShareSession: (id) => Effect.sync(() => void shareSessions.delete(id)),
    pruneShareAuth: (now, staleBefore) =>
      Effect.sync(() => {
        for (const [key, row] of shareSignIns) if (row.expiresAt <= now) shareSignIns.delete(key);
        for (const [key, row] of shareCodes) if (row.expiresAt <= now) shareCodes.delete(key);
        for (const [key, row] of shareSessions) if (row.lastUsedAt < staleBefore) shareSessions.delete(key);
      }),
    insertOAuthState: (row) => Effect.sync(() => void oauthStates.set(row.state, { ...row })),
    takeOAuthState: (state, now) =>
      Effect.sync(() => {
        const row = oauthStates.get(state);
        oauthStates.delete(state);
        return row === undefined || row.expiresAt <= now
          ? Option.none<OAuthStateRow>()
          : Option.some(row);
      }),

    upsertUser: (row) => Effect.sync(() => void users.set(row.id, { ...row })),
    findUser: (id) => Effect.sync(() => Option.fromNullishOr(users.get(id))),
    upsertTwitchAccount: (row) =>
      Effect.sync(() => void accounts.set(row.id, copyAccount(row))),
    findAccount: (id) => Effect.sync(() => Option.map(Option.fromNullishOr(accounts.get(id)), copyAccount)),
    findAccountByTwitchUser: (userId, twitchUserId) =>
      Effect.sync(() =>
        Option.map(
          Option.fromNullishOr(
            [...accounts.values()].find(
              (account) =>
                account.userId === userId && account.twitchUserId === twitchUserId,
            ),
          ),
          copyAccount,
        ),
      ),
    listAccountsByUser: (userId) =>
      Effect.sync(() =>
        [...accounts.values()].filter((account) => account.userId === userId).map(copyAccount),
      ),
    updateAccountSecrets: (id, secrets, updatedAt, lockToken) =>
      Effect.sync(() => {
        const current = accounts.get(id);
        if (current === undefined) return false;
        if (lockToken !== undefined && current.refreshLock !== lockToken) return false;
        accounts.set(id, {
          ...current,
          secrets,
          updatedAt,
          ...(lockToken === undefined ? {} : { refreshLock: null, refreshLockUntil: 0 }),
        });
        return true;
      }),
    updateAccountMachine: (id, machineId, updatedAt) =>
      Effect.sync(() => {
        const current = accounts.get(id);
        if (current !== undefined) accounts.set(id, { ...current, machineId, updatedAt });
      }),
    setAccountNeedsReauth: (id, needsReauth, updatedAt) =>
      Effect.sync(() => {
        const current = accounts.get(id);
        if (current !== undefined) accounts.set(id, { ...current, needsReauth, updatedAt });
      }),
    tryAcquireRefreshLock: (id, lockToken, now, lockUntil) =>
      Effect.sync(() => {
        const current = accounts.get(id);
        if (current === undefined) return false;
        if (current.refreshLock !== null && current.refreshLockUntil > now) return false;
        accounts.set(id, {
          ...current,
          refreshLock: lockToken,
          refreshLockUntil: lockUntil,
        });
        return true;
      }),
    releaseRefreshLock: (id, lockToken) =>
      Effect.sync(() => {
        const current = accounts.get(id);
        if (current !== undefined && current.refreshLock === lockToken)
          accounts.set(id, { ...current, refreshLock: null, refreshLockUntil: 0 });
      }),
    incrementRateLimit: ({ key, windowStart, expiresAt }) =>
      Effect.sync(() => {
        const current = rateLimits.get(key);
        const count =
          current !== undefined && current.windowStart === windowStart ? current.count + 1 : 1;
        rateLimits.set(key, { count, windowStart, expiresAt });
        return count;
      }),
    pruneRateLimits: (before) =>
      Effect.sync(() => {
        for (const [key, limit] of rateLimits) {
          if (limit.expiresAt < before) rateLimits.delete(key);
        }
      }),

    listHooks: (machineId) =>
      Effect.sync(() =>
        [...hooks.values()]
          .filter((hook) => hook.machineId === machineId)
          .map((hook) => structuredClone(hook)),
      ),
    findHook: (machineId, hookId) =>
      Effect.sync(() => {
        const hook = hooks.get(machineId + "\u0000" + hookId);
        return Option.fromNullishOr(hook === undefined ? undefined : structuredClone(hook));
      }),
    replaceHooks: (machineId, rows) =>
      Effect.sync(() => {
        for (const [key, hook] of hooks) {
          if (hook.machineId === machineId) hooks.delete(key);
        }
        for (const row of rows) hooks.set(machineId + "\u0000" + row.hookId, structuredClone(row));
      }),
    deleteHooks: (machineId, hookIds) =>
      Effect.sync(() => {
        for (const hookId of hookIds) hooks.delete(machineId + "\u0000" + hookId);
      }),
    pruneHooks: (before) =>
      Effect.sync(() => {
        for (const [key, hook] of hooks) {
          if (hook.updatedAt < before) hooks.delete(key);
        }
      }),

    insertPairingCode: (row) =>
      Effect.sync(() => void pairingCodes.set(row.code, { ...row })),
    takePairingCode: (code, now) =>
      Effect.sync(() => {
        const row = pairingCodes.get(code);
        pairingCodes.delete(code);
        return row === undefined || row.expiresAt <= now
          ? Option.none<PairingCodeRow>()
          : Option.some(row);
      }),
    insertMachine: (row) => Effect.sync(() => void machines.set(row.id, { ...row })),
    findMachine: (id) => Effect.sync(() => Option.fromNullishOr(machines.get(id))),
    findMachineByTokenHash: (tokenHash) =>
      Effect.sync(() =>
        Option.fromNullishOr(
          [...machines.values()].find((machine) => machine.tokenHash === tokenHash),
        ),
      ),
    touchMachine: (id, now) =>
      Effect.sync(() => {
        const current = machines.get(id);
        if (current !== undefined) machines.set(id, { ...current, lastSeenAt: now });
      }),

    listSubscriptions: (accountId) =>
      Effect.sync(() =>
        [...subscriptions.values()]
          .filter((subscription) => subscription.accountId === accountId)
          .map(copySubscription),
      ),
    findSubscriptionByProviderId: (providerId) =>
      Effect.sync(() =>
        Option.map(
          Option.fromNullishOr(
            [...subscriptions.values()].find(
              (subscription) => subscription.providerSubscriptionId === providerId,
            ),
          ),
          copySubscription,
        ),
      ),
    upsertSubscription: (row) =>
      Effect.sync(() => void subscriptions.set(row.id, copySubscription(row))),
    deleteSubscription: (id) =>
      Effect.sync(() => {
        subscriptions.delete(id);
        for (const [key, owner] of owners) {
          if (owner.subscriptionId === id) owners.delete(key);
        }
      }),
    listSubscriptionOwners: (accountId) =>
      Effect.sync(() =>
        [...owners.values()]
          .filter((owner) => subscriptions.get(owner.subscriptionId)?.accountId === accountId)
          .map((owner) => ({ ...owner })),
      ),
    upsertSubscriptionOwner: (row) =>
      Effect.sync(() => {
        owners.set(row.subscriptionId + "\u0000" + row.owner, { ...row });
      }),
    deleteSubscriptionOwner: (subscriptionId, owner) =>
      Effect.sync(() => {
        owners.delete(subscriptionId + "\u0000" + owner);
      }),
    markSubscriptionRevoked: (providerId, now, reason) =>
      Effect.sync(() => {
        for (const [id, subscription] of subscriptions) {
          if (subscription.providerSubscriptionId === providerId)
            subscriptions.set(id, {
              ...subscription,
              status: "revoked",
              lastError: reason ?? subscription.lastError,
              updatedAt: now,
            });
        }
      }),

    hasWebhookDelivery: (messageId) => Effect.sync(() => deliveries.has(messageId)),
    recordWebhookDelivery: (messageId, accountId, receivedAt) =>
      Effect.sync(() => {
        if (deliveries.has(messageId)) return false;
        deliveries.set(messageId, { accountId, receivedAt });
        return true;
      }),
    pruneWebhookDeliveries: (before) =>
      Effect.sync(() => {
        for (const [id, delivery] of deliveries) {
          if (delivery.receivedAt < before) deliveries.delete(id);
        }
      }),
  };
};
