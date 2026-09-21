export function serverBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid MSG_SERVER_URL'); }
  const authority = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/\\?#]*)/i)?.[1];
  if (!authority || authority.includes('@') || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash || value.includes('?') || value.includes('#')) {
    throw new Error('Server URL must use HTTP(S), without userinfo, query or fragment');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export function apiUrl(base, endpoint) {
  return new URL(endpoint.replace(/^\//, ''), serverBaseUrl(base));
}
