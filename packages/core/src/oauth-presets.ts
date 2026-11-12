/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. See legal/MPL-2.0.txt or https://mozilla.org/MPL/2.0/.
 * Adapted for MailIsle: extracted two public provider values into a typed export.
 * SPDX-License-Identifier: MPL-2.0 */
import type { OAuthClientInput, OAuthProvider } from '@mail/shared';

// Public desktop application values, not user credentials. Remove either entry to disable that preset.
// Source: https://hg.mozilla.org/comm-central/file/tip/mailnews/base/src/OAuth2Providers.sys.mjs
// Upstream asks other applications to register their own clients; see legal/THUNDERBIRD.md.
export const oauthPresets: Partial<Record<OAuthProvider, OAuthClientInput>> = {
  google: { clientId: '406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com', clientSecret: 'kSmqreRr0qwBWJgbf5Y-PjSU' },
  microsoft: { clientId: '9e5f94bc-e8a4-4e73-b8be-63364c29d753' },
};
