# Game News — Browser Extension

Chrome MV3 extension that integrates **Game News** into the Steam website
(`store.steampowered.com`, `steamcommunity.com`):

- Adds a **NEWS** entry to the Steam header that opens your personal feed
  full-page **inside the current page** (an iframe overlay below the Steam
  header), like the Millennium desktop plugin — not a new tab.
- Adds a **follow bell on a game's store page**, next to Steam's *Follow*
  button: one click to follow / unfollow that game's news. Empty when not
  followed, **green** when followed. Shown whether or not you own the game.

The same backend (`gamenews.up.railway.app`) and account (keyed by SteamID)
power the mobile app, the Millennium plugin and this extension.

## How it works

- **Content script** (`src/content/index.ts`, isolated world): injects the NEWS
  button + feed overlay and the store-page bell, detects the SteamID from the
  header profile link.
- **Service worker** (`src/background/index.ts`): does all backend calls (it has
  `host_permissions`, so no page CORS). It runs the one-time Steam OpenID popup
  to get a feed session, provisions the account (idempotent `/register`), and
  serves the bell's follow-state / follow / unfollow requests.
- **Follow bell**: state read on mount via `GET /api/web/follow-state/:id/:appId`
  (public, single boolean); toggle via `GET /api/web/follow` and
  `DELETE /api/web/follow/:id/:appId`. SteamID comes from the page, appId from
  the `/app/<id>/` URL — no Steam API dependency.

## Build

```bash
cd extension
npm install
npm run build        # → dist/ (unpacked extension)
npm run dev          # HMR dev build
npm run typecheck && npm run lint
```

## Install (Chrome / Edge / Brave)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select `extension/dist/`.
3. Open `https://store.steampowered.com/` while signed in to Steam.
4. The **NEWS** button appears in the header; the **bell** appears next to the
   wishlist button on a game's store page.

> After rebuilding, click the ↻ reload icon on the extension in
> `chrome://extensions`, then reload the Steam page.

## Project layout

```
extension/src/
├── manifest.ts            # MV3 manifest (CRXJS-typed)
├── background/index.ts    # service worker: session, register, follow ops
├── content/index.ts       # NEWS button + feed overlay + store follow bell
└── shared/
    ├── config.ts          # API base + storage keys
    └── messages.ts        # worker ↔ content message types
```

## Auth / privacy

Reads / writes are public-by-SteamID against the Game News backend (the same
accepted model as the Millennium plugin); sensitive actions (delete account,
settings) require a real Steam OpenID session obtained via the worker popup.
SteamID is public and the bell endpoints are idempotent and low-severity. See
the privacy policy: <https://gamenews.up.railway.app/privacy>.
