// Talking to the panel's own server. Same origin only; the page's content
// policy allows nothing else.

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function send(method, path, { params, body } = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers:
        method === 'GET'
          ? {}
          : // The header says the request came from this page (server.js).
            { 'Content-Type': 'application/json', 'X-Panel-Request': '1' },
      body: method === 'GET' ? undefined : JSON.stringify(body || {}),
    });
  } catch {
    throw new ApiError(0, 'The panel could not reach the bot. Is it running?');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/sign-in') {
      window.dispatchEvent(new Event('panel:signed-out'));
    }
    throw new ApiError(res.status, data?.error || `The bot answered ${res.status}.`);
  }
  return data;
}

export const get = (path, params) => send('GET', path, { params });
export const post = (path, body) => send('POST', path, { body });
