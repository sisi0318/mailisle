import type { OAuthClientInput, OAuthProvider } from '@mail/shared';

// Public desktop application values, not user credentials. Remove either entry to disable that preset.
// Source: https://hg.mozilla.org/comm-central/file/tip/mailnews/base/src/OAuth2Providers.sys.mjs
export const oauthPresets: Partial<Record<OAuthProvider, OAuthClientInput>> = {
  google: { clientId: '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com', clientSecret: 'kSmqreRr0qwBWJgbf5Y-PjSU' },
  microsoft: { clientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753' },
};
