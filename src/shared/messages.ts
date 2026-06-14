export type ExtensionMessage =
  | { type: 'STEAM_ID_DETECTED'; steamId: string }
  // Asks the worker to return a valid feed session token for `steamId`, running
  // the Steam OpenID popup flow if there's no cached, unexpired one.
  | { type: 'ENSURE_SESSION'; steamId: string }
  // Reads whether `steamId` already follows `appId` AND whether notifications are
  // on — drives the store-page [+]/bell two-tier state on mount.
  | { type: 'GET_FOLLOW_STATE'; steamId: string; appId: string }
  // Follows/unfollows `appId` for `steamId`. `notifications` sets the level on a
  // follow (false = silent, the [+] button). `name`/`logoUrl` seed the
  // GameSubscription metadata on the first follow.
  | {
      type: 'SET_FOLLOW';
      steamId: string;
      appId: string;
      follow: boolean;
      notifications?: boolean;
      name?: string;
      logoUrl?: string;
    }
  // Toggles notifications WITHOUT unfollowing (the bell on an already-followed
  // game).
  | { type: 'SET_NOTIFICATIONS'; steamId: string; appId: string; enabled: boolean };

export type MessageResponse =
  | { ok: true }
  | { ok: true; token: string }
  | { ok: true; followed: boolean; notified?: boolean }
  | { ok: false; error: string };
