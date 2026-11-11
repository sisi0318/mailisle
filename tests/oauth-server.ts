import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { oauthProviders } from '../packages/core/src/oauth';

export async function oauthServer() {
  const grants = new Map<string, URLSearchParams>();
  const requests: URLSearchParams[] = [];
  let error: string | undefined;
  let omitRefresh = false;
  let scope: string | undefined;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname.endsWith('/authorize')) {
      const code = randomUUID(); grants.set(code, url.searchParams);
      const redirect = new URL(url.searchParams.get('redirect_uri')!);
      redirect.search = new URLSearchParams({ code, state: url.searchParams.get('state')! }).toString();
      response.writeHead(302, { Location: redirect.href }).end(); return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk;
    const params = new URLSearchParams(raw); requests.push(params);
    const grant = grants.get(params.get('code') ?? '');
    if (params.get('grant_type') === 'authorization_code') {
      if (!grant || grant.get('redirect_uri') !== params.get('redirect_uri') || grant.get('client_id') !== params.get('client_id')
        || (grant.has('code_challenge') && createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url') !== grant.get('code_challenge'))) {
        response.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' })); return;
      }
      grants.delete(params.get('code')!);
    }
    response.setHeader('Content-Type', 'application/json');
    if (error) { response.writeHead(400).end(JSON.stringify({ error, error_description: 'PRIVATE-server-detail' })); return; }
    response.end(JSON.stringify({ token_type: 'Bearer', access_token: `access-${requests.length}`, expires_in: 3600,
      ...(omitRefresh ? {} : { refresh_token: `refresh-${requests.length}` }), scope: scope ?? grant?.get('scope') ?? params.get('scope') ?? undefined }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { requests, endpoints: {
    google: { ...oauthProviders.google, authorize: `${base}/google/authorize`, token: `${base}/google/token` },
    microsoft: { ...oauthProviders.microsoft, authorize: `${base}/microsoft/authorize`, token: `${base}/microsoft/token` },
  }, setError(value?: string) { error = value; }, omitRefresh(value: boolean) { omitRefresh = value; }, setScope(value?: string) { scope = value; },
  async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

export async function callbackUrl(authorizationUrl: string) {
  const response = await fetch(authorizationUrl, { redirect: 'manual' });
  return response.headers.get('location')!;
}
