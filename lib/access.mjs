export function allowedAddresses(port, publicOrigin) {
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('CONVOX_PUBLIC_ORIGIN must be one HTTP(S) origin without credentials, path, query or fragment');
    }
    origins.add(url.origin);
    hosts.add(url.host);
  }
  return { origins, hosts };
}
