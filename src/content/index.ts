// Isolated-world content script. Responsibilities:
//   1. Inject a "NEWS" entry into Steam's global header.
//   2. On click, show the Game News feed full-screen INSIDE the current Steam
//      page — an <iframe> overlay anchored below the Steam header (header with
//      Store / Library / Community + NEWS stays visible) — like the Millennium
//      plugin, NOT a new tab. The feed is private: the worker provides a Steam
//      session (one-time OpenID popup) which we pass to the iframe via the URL
//      hash (#gn_session) because Chrome partitions the embedded iframe's
//      storage. News-article clicks bubble up from the feed and navigate the tab.
//   3. Detect the user's SteamID64 from the header profile link and persist it.
//
// NOTE: keep this file free of ANY import/export — even `import type`. Any
// import/export turns it into an ES module, which crxjs then ships as a loader
// importing extra chunks; keeping it self-contained ships it as one classic,
// web-accessible content script. Hence the inlined constants and message shapes.
const FEED_ORIGIN = 'https://gamenews.up.railway.app';
const BUTTON_ID = 'game-news-nav-button';
const OVERLAY_ID = 'game-news-overlay';
const BELL_ID = 'game-news-follow-bell';
const PLUS_ID = 'game-news-follow-plus';
const CONTROLS_ID = 'game-news-follow-controls';
const STEAM_ID_FROM_PROFILE_URL = /\/profiles\/(\d{17})/;
const APP_ID_FROM_PATH = /\/app\/(\d+)/;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Relaie les erreurs de ce content script au service worker (qui a Sentry). Ce
// fichier ne peut PAS importer Sentry (cf. note en tête : aucun import/export),
// donc on remonte via un message. Fire-and-forget.
function reportError(message: string, stack?: string): void {
  try {
    chrome.runtime.sendMessage({ type: 'REPORT_ERROR', message, stack });
  } catch {
    /* worker indisponible (rechargement de l'extension) — on n'insiste pas */
  }
}
window.addEventListener('error', (event) => {
  reportError(event.message, event.error?.stack);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  reportError(
    reason instanceof Error ? reason.message : String(reason),
    reason instanceof Error ? reason.stack : undefined,
  );
});

// Local mirror of MessageResponse (this file stays import/export-free — see note
// above — so the worker's response type is inlined here).
type FollowResponse =
  | { ok: true; followed?: boolean; notified?: boolean }
  | { ok: false; error?: string }
  | undefined;

function detectSteamId(): string | null {
  const link = document.querySelector<HTMLAnchorElement>(
    'a[href*="/profiles/7656"]',
  );
  if (!link) {
    return null;
  }
  const match = link.href.match(STEAM_ID_FROM_PROFILE_URL);
  return match?.[1] ?? null;
}

// ── Feed overlay (the feed, full-screen inside the page) ────────────────────

// Bottom Y of Steam's global header, so the overlay starts right under it and
// the header stays visible/clickable. Works on both store and community.
function steamHeaderBottom(): number {
  const header =
    document.querySelector<HTMLElement>('#global_header') ??
    document.querySelector<HTMLElement>('.responsive_header');
  const bottom = header ? header.getBoundingClientRect().bottom : 0;
  return Math.max(0, Math.round(bottom));
}

function setNewsActive(active: boolean): void {
  const btn = document.getElementById(BUTTON_ID);
  if (!btn) {
    return;
  }
  if (active) {
    btn.style.setProperty('color', '#66c0f4', 'important');
  } else if (btn.classList.contains('menuitem')) {
    // Native nav item: hand the colour back to Steam's CSS (white + hover).
    btn.style.removeProperty('color');
  } else {
    btn.style.color = '#ffffff';
  }
}

function closeOverlay(): void {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) {
    return;
  }
  document.documentElement.style.overflow =
    overlay.getAttribute('data-prev-overflow') ?? '';
  overlay.remove();
  setNewsActive(false);
}

function centeredMessage(text: string): HTMLDivElement {
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'absolute',
    inset: '0',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#8f98a0',
    fontFamily: '"Motiva Sans", Arial, Helvetica, sans-serif',
    fontSize: '14px',
  } satisfies Partial<CSSStyleDeclaration>);
  box.textContent = text;
  return box;
}

function openOverlay(steamId: string): void {
  if (document.getElementById(OVERLAY_ID)) {
    return;
  }
  // Pin the page at the top and lock scroll so the Steam header stays put while
  // the feed fills the area below it (matches the plugin's full-page feel).
  window.scrollTo(0, 0);

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('data-prev-overflow', document.documentElement.style.overflow);
  Object.assign(overlay.style, {
    position: 'fixed',
    left: '0',
    right: '0',
    bottom: '0',
    top: `${steamHeaderBottom()}px`,
    zIndex: '99999',
    background: '#1b2838',
  } satisfies Partial<CSSStyleDeclaration>);
  document.documentElement.style.overflow = 'hidden';

  const content = document.createElement('div');
  content.className = 'gn-overlay-content';
  Object.assign(content.style, {
    position: 'absolute',
    inset: '0',
  } satisfies Partial<CSSStyleDeclaration>);

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Fermer');
  Object.assign(closeBtn.style, {
    position: 'absolute',
    top: '8px',
    right: '14px',
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    border: 'none',
    background: 'rgba(0,0,0,0.55)',
    color: '#fff',
    fontSize: '15px',
    lineHeight: '32px',
    cursor: 'pointer',
    zIndex: '1',
  } satisfies Partial<CSSStyleDeclaration>);
  closeBtn.addEventListener('click', closeOverlay);

  overlay.appendChild(content);
  overlay.appendChild(closeBtn);
  document.body.appendChild(overlay);
  setNewsActive(true);

  void mountFeed(steamId, content);
}

// Gets a session from the worker (which runs the one-time OpenID popup if
// needed) and loads the feed iframe with it. Shows a connecting/error state in
// the meantime. Re-entrancy-safe via the OVERLAY_ID guard above.
async function mountFeed(steamId: string, content: HTMLElement): Promise<void> {
  content.replaceChildren(centeredMessage('Connexion à Steam…'));

  let response: { ok?: boolean; token?: string; error?: string } | undefined;
  try {
    response = (await chrome.runtime.sendMessage({
      type: 'ENSURE_SESSION' as const,
      steamId,
    })) as { ok?: boolean; token?: string; error?: string };
  } catch {
    response = undefined;
  }

  // The overlay may have been closed while we waited.
  if (!document.getElementById(OVERLAY_ID) || !content.isConnected) {
    return;
  }

  if (!response || !response.ok || !response.token) {
    showRetry(steamId, content);
    return;
  }

  const frame = document.createElement('iframe');
  frame.src = `${FEED_ORIGIN}/feed/${steamId}#gn_session=${encodeURIComponent(
    response.token,
  )}`;
  Object.assign(frame.style, {
    width: '100%',
    height: '100%',
    border: '0',
    display: 'block',
  } satisfies Partial<CSSStyleDeclaration>);
  content.replaceChildren(frame);
}

function showRetry(steamId: string, content: HTMLElement): void {
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'absolute',
    inset: '0',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#c7d5e0',
    fontFamily: '"Motiva Sans", Arial, Helvetica, sans-serif',
    fontSize: '14px',
  } satisfies Partial<CSSStyleDeclaration>);
  const msg = document.createElement('div');
  msg.textContent = 'Connexion à Steam annulée ou échouée.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Réessayer';
  Object.assign(retry.style, {
    background: '#1a9fff',
    color: '#fff',
    border: 'none',
    borderRadius: '4px',
    padding: '9px 18px',
    fontSize: '14px',
    fontWeight: '600',
    cursor: 'pointer',
  } satisfies Partial<CSSStyleDeclaration>);
  retry.addEventListener('click', () => void mountFeed(steamId, content));
  box.appendChild(msg);
  box.appendChild(retry);
  content.replaceChildren(box);
}

function toggleOverlay(): void {
  if (document.getElementById(OVERLAY_ID)) {
    closeOverlay();
    return;
  }
  const steamId = detectSteamId();
  if (steamId) {
    openOverlay(steamId);
  }
}

// The feed (railway origin) postMessages article clicks up to us. Open the Steam
// article in the current tab, like the plugin opens it in Steam's Community tab.
window.addEventListener('message', (event: MessageEvent) => {
  if (event.origin !== FEED_ORIGIN) {
    return;
  }
  const data = event.data as { type?: string; url?: string } | null;
  if (!data || typeof data !== 'object') {
    return;
  }
  if (data.type === 'gamenews-open-url' && typeof data.url === 'string') {
    closeOverlay();
    window.location.href = data.url;
  }
});

// ── Follow bell (on a game's store page) ────────────────────────────────────

// The appId is in the store URL: /app/<appid>/Name/. Returns null off a game page.
function detectAppId(): string | null {
  const match = window.location.pathname.match(APP_ID_FROM_PATH);
  return match?.[1] ?? null;
}

// The action row on a game's store page that holds Steam's queue buttons
// (wishlist / follow / ignore / share). The exact button MIX varies per game and
// account state — Follow is missing on some pages (e.g. DLC), the wishlist
// button disappears once owned — so the bell anchors on the CONTAINER, never on
// a sibling button (anchoring on wishlist then Follow both broke when that
// button happened to be absent). Same fix as the Millennium plugin's webkit
// bell, validated at runtime there (v1.2.5).
// Primary: #queueActionsCtn (Valve's id for the row). Fallback: derive the row
// from whatever .queue_control_button is present (Ignore is always rendered).
function actionsContainer(): HTMLElement | null {
  const ctn = document.querySelector<HTMLElement>('#queueActionsCtn');
  if (ctn) {
    return ctn;
  }
  const anyBtn = document.querySelector<HTMLElement>('.queue_control_button');
  return anyBtn ? anyBtn.parentElement : null;
}

const ICON_GREEN = '#a4d007'; // Steam green when active
const ICON_IDLE = '#c7d5e0';

// All icons are built via the DOM (not innerHTML) so Steam's Trusted-Types CSP
// can't block them.
function strokePath(d: string): SVGPathElement {
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  return p;
}

// Bell, Steam-green when notifications are ON.
function makeBellIcon(notified: boolean): SVGSVGElement {
  const color = notified ? ICON_GREEN : ICON_IDLE;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', notified ? color : 'none');
  svg.setAttribute('stroke', color);
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.appendChild(strokePath('M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9'));
  svg.appendChild(strokePath('M13.73 21a2 2 0 0 1-3.46 0'));
  return svg;
}

// "+" when not followed, checkmark when followed. Green once followed.
function makePlusIcon(followed: boolean): SVGSVGElement {
  const color = followed ? ICON_GREEN : ICON_IDLE;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', color);
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.appendChild(strokePath(followed ? 'M20 6L9 17l-5-5' : 'M12 5v14M5 12h14'));
  return svg;
}

function styleControlButton(btn: HTMLButtonElement): void {
  Object.assign(btn.style, {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    verticalAlign: 'middle',
    border: '1px solid rgba(255,255,255,0.18)',
    borderRadius: '4px',
    background: 'rgba(0,0,0,0.25)',
    cursor: 'pointer',
    padding: '0',
    transition: 'opacity 120ms ease',
  } satisfies Partial<CSSStyleDeclaration>);
}

// data-followed / data-notified on the container are the single source of truth
// for the pair; both icons are re-rendered from them.
function setControlsState(
  container: HTMLElement,
  followed: boolean,
  notified: boolean,
): void {
  container.setAttribute('data-followed', followed ? 'true' : 'false');
  container.setAttribute('data-notified', notified ? 'true' : 'false');
  const plus = container.querySelector<HTMLElement>(`#${PLUS_ID}`);
  const bell = container.querySelector<HTMLElement>(`#${BELL_ID}`);
  if (plus) {
    plus.setAttribute('aria-pressed', followed ? 'true' : 'false');
    plus.title = followed
      ? 'Ne plus suivre ce jeu'
      : 'Suivre ce jeu (sans notifications)';
    plus.setAttribute('aria-label', plus.title);
    plus.replaceChildren(makePlusIcon(followed));
  }
  if (bell) {
    bell.setAttribute('aria-pressed', notified ? 'true' : 'false');
    bell.title = notified
      ? 'Couper les notifications'
      : 'Activer les notifications';
    bell.setAttribute('aria-label', bell.title);
    bell.replaceChildren(makeBellIcon(notified));
  }
}

function setControlsBusy(container: HTMLElement, busy: boolean): void {
  container.setAttribute('aria-busy', busy ? 'true' : 'false');
  container.style.opacity = busy ? '0.6' : '1';
  container.style.pointerEvents = busy ? 'none' : '';
}

function gameMeta(appId: string): { name?: string; logoUrl: string } {
  const nameEl = document.querySelector<HTMLElement>(
    '#appHubAppName, .apphub_AppName',
  );
  return {
    name: nameEl?.textContent?.trim() || undefined,
    logoUrl: `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
  };
}

async function sendFollowMessage(message: object): Promise<FollowResponse> {
  try {
    return (await chrome.runtime.sendMessage(message)) as FollowResponse;
  } catch {
    return undefined;
  }
}

// Optimistic mutation helper: apply `optimistic` state, run the request, adopt
// the worker's authoritative state on success or revert on failure.
async function runControls(
  container: HTMLElement,
  optimistic: { followed: boolean; notified: boolean },
  message: object,
): Promise<void> {
  if (container.getAttribute('aria-busy') === 'true') {
    return;
  }
  const prevFollowed = container.getAttribute('data-followed') === 'true';
  const prevNotified = container.getAttribute('data-notified') === 'true';
  setControlsState(container, optimistic.followed, optimistic.notified);
  setControlsBusy(container, true);
  const res = await sendFollowMessage(message);
  setControlsBusy(container, false);
  if (!res || !res.ok) {
    setControlsState(container, prevFollowed, prevNotified); // revert
    return;
  }
  setControlsState(
    container,
    res.followed ?? optimistic.followed,
    res.notified ?? optimistic.notified,
  );
}

// [+] : not followed → silent follow ; followed → unfollow.
function onPlusClick(container: HTMLElement, steamId: string, appId: string): void {
  const followed = container.getAttribute('data-followed') === 'true';
  if (followed) {
    void runControls(container, { followed: false, notified: false }, {
      type: 'SET_FOLLOW' as const,
      steamId,
      appId,
      follow: false,
    });
    return;
  }
  const meta = gameMeta(appId);
  void runControls(container, { followed: true, notified: false }, {
    type: 'SET_FOLLOW' as const,
    steamId,
    appId,
    follow: true,
    notifications: false,
    name: meta.name,
    logoUrl: meta.logoUrl,
  });
}

// bell : not followed → follow + notify ; followed → toggle notifications.
function onBellClick(container: HTMLElement, steamId: string, appId: string): void {
  const followed = container.getAttribute('data-followed') === 'true';
  const notified = container.getAttribute('data-notified') === 'true';
  if (!followed) {
    const meta = gameMeta(appId);
    void runControls(container, { followed: true, notified: true }, {
      type: 'SET_FOLLOW' as const,
      steamId,
      appId,
      follow: true,
      notifications: true,
      name: meta.name,
      logoUrl: meta.logoUrl,
    });
    return;
  }
  void runControls(container, { followed: true, notified: !notified }, {
    type: 'SET_NOTIFICATIONS' as const,
    steamId,
    appId,
    enabled: !notified,
  });
}

function buildControls(steamId: string, appId: string): HTMLElement {
  const container = document.createElement('span');
  container.id = CONTROLS_ID;
  Object.assign(container.style, {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    marginRight: '8px',
    verticalAlign: 'middle',
  } satisfies Partial<CSSStyleDeclaration>);

  const plus = document.createElement('button');
  plus.id = PLUS_ID;
  plus.type = 'button';
  styleControlButton(plus);
  plus.addEventListener('click', (event) => {
    event.preventDefault();
    onPlusClick(container, steamId, appId);
  });

  const bell = document.createElement('button');
  bell.id = BELL_ID;
  bell.type = 'button';
  styleControlButton(bell);
  bell.addEventListener('click', (event) => {
    event.preventDefault();
    onBellClick(container, steamId, appId);
  });

  container.appendChild(plus);
  container.appendChild(bell);
  setControlsState(container, false, false);
  return container;
}

function injectBell(): void {
  if (document.getElementById(CONTROLS_ID)) {
    return;
  }
  // Store game pages only (the buy/wishlist page). Community hubs match the same
  // anchor but are out of scope; extend the host check if ever wanted there.
  if (window.location.hostname !== 'store.steampowered.com') {
    return;
  }
  const appId = detectAppId();
  if (!appId) {
    return; // not a game page
  }
  const steamId = detectSteamId();
  if (!steamId) {
    return; // not signed in to Steam → nothing to follow against
  }
  const row = actionsContainer();
  if (!row) {
    return; // action row not in the DOM yet → the observer retries
  }
  const controls = buildControls(steamId, appId);
  // Placement : JAMAIS en fin de rangée — vérifié au runtime côté plugin
  // (Destiny 2 DLC) : le conteneur garde des enfants cachés par Valve (états
  // wishlist, flyouts) et un contrôle appendé après eux est invisible. On
  // s'insère avant le premier bouton VISIBLE :
  //   1. avant « Suivre » s'il est visible (placement historique) ;
  //   2. sinon avant le premier .queue_control_button visible (ex. DLC) ;
  //   3. sinon en tête de rangée.
  const isVisible = (el: HTMLElement): boolean =>
    el.offsetParent !== null && el.offsetWidth > 0;
  const followBtn = row.querySelector<HTMLElement>(
    '.queue_control_button.queue_btn_follow',
  );
  if (followBtn && isVisible(followBtn)) {
    followBtn.insertAdjacentElement('beforebegin', controls);
  } else {
    const firstVisibleBtn = Array.from(
      row.querySelectorAll<HTMLElement>('.queue_control_button'),
    ).find(isVisible);
    if (firstVisibleBtn) {
      firstVisibleBtn.insertAdjacentElement('beforebegin', controls);
    } else {
      row.prepend(controls);
    }
  }

  // Reflect the current state on mount ([+] green if followed, bell green if
  // notifications are on).
  void (async () => {
    const res = await sendFollowMessage({
      type: 'GET_FOLLOW_STATE' as const,
      steamId,
      appId,
    });
    if (res && res.ok && typeof res.followed === 'boolean') {
      setControlsState(controls, res.followed, Boolean(res.notified));
    }
  })();
}

// ── SteamID detection → background persistence ──────────────────────────────

let lastReportedSteamId: string | null = null;

function reportSteamIdIfChanged(): void {
  const steamId = detectSteamId();
  if (!steamId || steamId === lastReportedSteamId) {
    return;
  }
  lastReportedSteamId = steamId;
  // Local shape (no import): mirrors ExtensionMessage 'STEAM_ID_DETECTED'.
  void chrome.runtime.sendMessage({ type: 'STEAM_ID_DETECTED' as const, steamId });
}

// ── NEWS header button ──────────────────────────────────────────────────────

function buildButton(): HTMLAnchorElement {
  const btn = document.createElement('a');
  btn.id = BUTTON_ID;
  btn.textContent = 'NEWS';
  btn.href = '#';
  btn.setAttribute('role', 'button');
  btn.setAttribute('aria-label', 'Ouvrir Game News');
  Object.assign(btn.style, {
    color: '#ffffff',
    textDecoration: 'none',
    cursor: 'pointer',
    padding: '0 14px',
    fontFamily: '"Motiva Sans", Arial, Helvetica, sans-serif',
    fontWeight: '400',
    fontSize: '13px',
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
    display: 'inline-flex',
    alignItems: 'center',
    height: '100%',
    marginRight: '12px',
    transition: 'color 120ms ease',
  } satisfies Partial<CSSStyleDeclaration>);

  btn.addEventListener('mouseenter', () => {
    btn.style.color = '#66c0f4';
  });
  btn.addEventListener('mouseleave', () => {
    // Keep the active (blue) colour while the feed overlay is open.
    btn.style.color = document.getElementById(OVERLAY_ID) ? '#66c0f4' : '#ffffff';
  });
  btn.addEventListener('click', (event) => {
    event.preventDefault();
    toggleOverlay();
  });

  return btn;
}

// Clones an existing main-nav link (Store / Community / Support…) so NEWS
// inherits Steam's native styling, then turns it into our button.
function buildMenuItem(sample: HTMLElement): HTMLAnchorElement {
  const item = sample.cloneNode(true) as HTMLAnchorElement;
  item.id = BUTTON_ID;
  item.textContent = 'NEWS';
  item.setAttribute('href', '#');
  item.removeAttribute('onclick');
  item.classList.remove('active', 'selected'); // in case the cloned one was active
  item.style.cursor = 'pointer';
  item.addEventListener('click', (event) => {
    event.preventDefault();
    toggleOverlay();
  });
  return item;
}

function injectButton(): void {
  if (document.getElementById(BUTTON_ID)) {
    return;
  }
  // Preferred: on the SAME row as Store / Community / … / Support — append after
  // the last main-nav item so NEWS sits inline (like the Millennium plugin).
  const items = document.querySelectorAll<HTMLElement>('#global_header .menuitem');
  const last = items[items.length - 1];
  if (last) {
    last.insertAdjacentElement('afterend', buildMenuItem(last));
    return;
  }
  // Fallback: the user-actions menu (top-right) if the main nav isn't present.
  const menu = document.querySelector('#global_action_menu');
  if (menu) {
    menu.insertBefore(buildButton(), menu.firstChild);
  }
}

// Initial pass + observer for SPA-style DOM updates and late-mounted avatar.
const observer = new MutationObserver(() => {
  injectButton();
  injectBell();
  reportSteamIdIfChanged();
});
observer.observe(document.body, { childList: true, subtree: true });
injectButton();
injectBell();
reportSteamIdIfChanged();
