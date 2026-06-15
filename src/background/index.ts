// Service worker (MV3). Two jobs:
//   1. Persist the SteamID the content script detects.
//   2. Provide the feed a Steam session WITHOUT a login wall: it runs Steam
//      OpenID in a popup window and returns the session token to the content
//      script, which hands it to the embedded feed via the URL (#gn_session).
//
// Why the worker (not the content script) does this:
//   - it has host_permissions for the API → cross-origin fetch without CORS,
//   - chrome.windows.create opens/closes the popup reliably (no user-gesture /
//     popup-blocker / COOP issues that plague window.open from a page),
//   - the session is cached here and reused until expiry, so the popup only
//     appears the first time.

import { API_BASE, STORAGE_KEYS } from '@/shared/config';
import type { ExtensionMessage, MessageResponse } from '@/shared/messages';

// Public-by-SteamID surface (same one the Millennium plugin uses). The worker —
// not the content script — calls it: it has host_permissions, so these are
// extension-initiated requests not subject to the page's CORS.
const API_WEB = `${API_BASE}/api/web`;

chrome.runtime.onMessage.addListener(
  (
    message: ExtensionMessage,
    _sender,
    sendResponse: (response: MessageResponse) => void,
  ): boolean => {
    void handleMessage(message).then(sendResponse);
    return true; // keep the channel open for the async response
  },
);

async function handleMessage(
  message: ExtensionMessage,
): Promise<MessageResponse> {
  switch (message.type) {
    case 'STEAM_ID_DETECTED': {
      await chrome.storage.local.set({ [STORAGE_KEYS.STEAM_ID]: message.steamId });
      // Make sure a backend account exists so the bell can follow against it,
      // even for a user who never opened the NEWS feed (no OpenID). Idempotent.
      void ensureRegistered(message.steamId);
      return { ok: true };
    }
    case 'ENSURE_SESSION': {
      return ensureSession(message.steamId);
    }
    case 'GET_FOLLOW_STATE': {
      return getFollowState(message.steamId, message.appId);
    }
    case 'SET_FOLLOW': {
      return setFollow(message);
    }
    case 'SET_NOTIFICATIONS': {
      return setNotifications(message.steamId, message.appId, message.enabled);
    }
  }
}

// ── Store-page bell: provisioning, follow state, follow/unfollow ─────────────

// Idempotent account provisioning (mirrors the Millennium plugin's boot call).
// Guarded so we hit it once per SteamID; the endpoint is idempotent (202) and
// kicks the initial library sync only on a brand-new account.
async function ensureRegistered(steamId: string): Promise<void> {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.REGISTERED);
    if (data[STORAGE_KEYS.REGISTERED] === steamId) {
      return;
    }
    const res = await fetch(`${API_WEB}/register/${steamId}`);
    if (res.ok) {
      await chrome.storage.local.set({ [STORAGE_KEYS.REGISTERED]: steamId });
    }
  } catch {
    /* transient — retried on the next detection */
  }
}

async function getFollowState(
  steamId: string,
  appId: string,
): Promise<MessageResponse> {
  try {
    const res = await fetch(`${API_WEB}/follow-state/${steamId}/${appId}`);
    // 404 = account not provisioned yet → treat as not-followed (bell empty).
    if (res.status === 404) {
      return { ok: true, followed: false };
    }
    if (!res.ok) {
      return { ok: false, error: `follow-state HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      followed?: boolean;
      notifications?: boolean;
    };
    const followed = Boolean(data.followed);
    // notified ⊆ followed : un suivi silencieux a notifications === false.
    return { ok: true, followed, notified: followed && data.notifications !== false };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function setFollow(msg: {
  steamId: string;
  appId: string;
  follow: boolean;
  notifications?: boolean;
  name?: string;
  logoUrl?: string;
}): Promise<MessageResponse> {
  try {
    if (!msg.follow) {
      const ok = await requestUnfollow(msg.steamId, msg.appId);
      return ok
        ? { ok: true, followed: false, notified: false }
        : { ok: false, error: 'unfollow request failed' };
    }
    const notify = msg.notifications !== false;
    const ok = await requestFollow(msg, notify);
    return ok
      ? { ok: true, followed: true, notified: notify }
      : { ok: false, error: 'follow request failed' };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Writes prove identity with the OpenID Bearer session (the backend rejects a
// bare SteamID on writes — see requireWebAuth). The bell REUSES the session
// already established when the user opened the NEWS feed; it NEVER triggers a
// login itself (cachedToken, not obtainToken). If there's no cached session yet
// (the feed was never opened), the write simply no-ops — no popup. The only
// login in the extension stays the one-time one on opening the feed.
async function authedWebFetch(
  steamId: string,
  url: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const token = await cachedToken(steamId);
  if (!token) {
    return null;
  }
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

async function requestFollow(
  msg: {
    steamId: string;
    appId: string;
    name?: string;
    logoUrl?: string;
  },
  notifications: boolean,
): Promise<boolean> {
  const url = new URL(`${API_WEB}/follow`);
  url.searchParams.set('steamId', msg.steamId);
  url.searchParams.set('appId', msg.appId);
  url.searchParams.set('notifications', notifications ? 'true' : 'false');
  if (msg.name) {
    url.searchParams.set('name', msg.name);
  }
  if (msg.logoUrl) {
    url.searchParams.set('logoUrl', msg.logoUrl);
  }

  let res = await authedWebFetch(msg.steamId, url.toString());
  // Brand-new install whose account isn't provisioned yet → provision and retry.
  // register is public/idempotent (no auth), so a plain fetch is fine here.
  if (res && res.status === 404) {
    try {
      await fetch(`${API_WEB}/register/${msg.steamId}`);
    } catch {
      /* ignore — the retry below surfaces a real failure */
    }
    await sleep(1500);
    res = await authedWebFetch(msg.steamId, url.toString());
  }
  return Boolean(res && res.ok);
}

async function requestUnfollow(steamId: string, appId: string): Promise<boolean> {
  const res = await authedWebFetch(steamId, `${API_WEB}/follow/${steamId}/${appId}`, {
    method: 'DELETE',
  });
  return Boolean(res && res.ok);
}

// Toggle notifications without unfollowing (the bell on an already-followed
// game). Uses the GET|POST query-param alias (same as the SPA web surface).
async function setNotifications(
  steamId: string,
  appId: string,
  enabled: boolean,
): Promise<MessageResponse> {
  try {
    const res = await authedWebFetch(
      steamId,
      `${API_WEB}/follow-notifications/${steamId}/${appId}?enabled=${
        enabled ? 'true' : 'false'
      }`,
      { method: 'POST' },
    );
    if (!res) {
      return { ok: false, error: 'session indisponible' };
    }
    return res.ok
      ? { ok: true, followed: true, notified: enabled }
      : { ok: false, error: `notifications HTTP ${res.status}` };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface CachedSession {
  token: string;
  steamId: string;
}

// The session token's payload (base64url, first segment) carries `exp` in ms.
function tokenExpiryMs(token: string): number | null {
  try {
    const payload = token.split('.')[0] || '';
    const json = JSON.parse(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
    ) as { exp?: number };
    return typeof json.exp === 'number' ? json.exp : null;
  } catch {
    return null;
  }
}

function isUsable(token: string): boolean {
  const exp = tokenExpiryMs(token);
  // 1-minute safety margin so we never hand the feed a token about to expire.
  return exp == null || Date.now() < exp - 60_000;
}

async function cachedToken(steamId: string): Promise<string | null> {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SESSION);
  const session = data[STORAGE_KEYS.SESSION] as CachedSession | undefined;
  if (session?.token && session.steamId === steamId && isUsable(session.token)) {
    return session.token;
  }
  return null;
}

// Returns a usable session token for the SteamID: the cached one if still valid,
// otherwise it runs the one-time Steam OpenID popup and caches the result.
// Returns null if login fails/cancels. Shared by the feed (ENSURE_SESSION) and
// the store-bell writes (authedWebFetch).
async function obtainToken(steamId: string): Promise<string | null> {
  const cached = await cachedToken(steamId);
  if (cached) {
    return cached;
  }

  const startRes = await fetch(`${API_BASE}/auth/steam/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'extension' }),
  });
  if (!startRes.ok) {
    return null;
  }
  const { authToken, authUrl } = (await startRes.json()) as {
    authToken: string;
    authUrl: string;
  };

  const popup = await chrome.windows.create({
    url: authUrl,
    type: 'popup',
    width: 520,
    height: 720,
  });
  try {
    const token = await pollForSession(authToken);
    const session: CachedSession = { token, steamId };
    await chrome.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
    return token;
  } finally {
    if (popup?.id != null) {
      try {
        await chrome.windows.remove(popup.id);
      } catch {
        /* already closed by the user */
      }
    }
  }
}

async function ensureSession(steamId: string): Promise<MessageResponse> {
  try {
    const token = await obtainToken(steamId);
    return token
      ? { ok: true, token }
      : { ok: false, error: 'session indisponible' };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls /auth/steam/status (exempt from the auth rate limit) until OpenID
// completes. ~45s budget — Steam's "Sign in" is near-instant once logged in.
async function pollForSession(authToken: string): Promise<string> {
  for (let i = 0; i < 30; i += 1) {
    await sleep(1500);
    let res: Response;
    try {
      res = await fetch(
        `${API_BASE}/auth/steam/status/${encodeURIComponent(authToken)}`,
      );
    } catch {
      continue; // transient network hiccup → keep polling
    }
    if (!res.ok) {
      continue;
    }
    const data = (await res.json()) as { status: string; sessionToken?: string };
    if (data.status === 'succeeded' && data.sessionToken) {
      return data.sessionToken;
    }
    if (data.status === 'expired') {
      throw new Error('login attempt expired');
    }
  }
  throw new Error('login timed out');
}
