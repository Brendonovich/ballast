/**
 * Twitch topic keys. The rest of Ballast keys topics as
 * `integration/topic`, so every EventSub subscription type gets a
 * `twitch/<subscription type>` key.
 */
export const INTEGRATION = "twitch";

export type TwitchTopicKey<Type extends string = string> = `twitch/${Type}`;

export const topicKey = <const Type extends string>(type: Type): TwitchTopicKey<Type> =>
  `twitch/${type}`;
