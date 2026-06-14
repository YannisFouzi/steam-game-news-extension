export const API_BASE = 'https://gamenews.up.railway.app';

export const STORAGE_KEYS = {
  STEAM_ID: 'steamId',
  LAST_SEEN_AT: 'lastSeenAt',
  // Cached feed session { token, steamId } obtained via Steam OpenID, reused
  // until the token expires so the login popup only appears once.
  SESSION: 'session',
  // SteamID we've already provisioned (idempotent /register) — guards against
  // re-calling on every detection. The endpoint is idempotent anyway.
  REGISTERED: 'registeredSteamId',
} as const;
