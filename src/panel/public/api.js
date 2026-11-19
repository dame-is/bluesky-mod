// Talking to the panel's own server, through the client any admin page can
// use (client/api.js). Same origin only; the page's content policy allows
// nothing else.

import { ApiError, createClient } from '/client/api.js';

export { ApiError };

const client = createClient({
  onSignedOut: () => window.dispatchEvent(new Event('panel:signed-out')),
});

export const get = (path, params) => client.get(path, params);
export const post = (path, body) => client.post(path, body);
