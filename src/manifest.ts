import { defineManifest } from '@crxjs/vite-plugin';
import pkg from '../package.json';

export default defineManifest({
  manifest_version: 3,
  name: 'Game News',
  description: 'Steam game news + library tracking, integrated into the Steam website and desktop client.',
  version: pkg.version,
  icons: {
    16: 'public/icons/icon-16.png',
    48: 'public/icons/icon-48.png',
    128: 'public/icons/icon-128.png',
  },
  action: {
    default_title: 'Game News',
    default_icon: {
      16: 'public/icons/icon-16.png',
      48: 'public/icons/icon-48.png',
      128: 'public/icons/icon-128.png',
    },
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module',
  },
  content_scripts: [
    {
      matches: [
        'https://store.steampowered.com/*',
        'https://steamcommunity.com/*',
      ],
      js: ['src/content/index.ts'],
      run_at: 'document_idle',
    },
  ],
  permissions: ['storage', 'alarms', 'notifications'],
  host_permissions: [
    'https://gamenews.up.railway.app/*',
    'https://store.steampowered.com/*',
    'https://steamcommunity.com/*',
    // Ingest Sentry (gamenotif-extension, région EU) — le service worker y poste
    // les erreurs sans contrainte CORS. Voir SENTRY_SETUP.md §6.
    'https://o4511158959931392.ingest.de.sentry.io/*',
  ],
});
