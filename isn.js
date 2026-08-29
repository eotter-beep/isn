/* ISN browser client. Storage is always remote; there is no local fallback. */
(function (root) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function encode(value) {
    if (typeof value === 'string') return { type: 'text', bytes: encoder.encode(value) };
    if (value instanceof Uint8Array) return { type: 'bytes', bytes: value };
    if (value instanceof ArrayBuffer) return { type: 'bytes', bytes: new Uint8Array(value) };
    return { type: 'json', bytes: encoder.encode(JSON.stringify(value)) };
  }

  function decode(type, bytes) {
    if (type === 'text') return decoder.decode(bytes);
    if (type === 'bytes') return bytes;
    return JSON.parse(decoder.decode(bytes));
  }

  function toBase64(bytes) {
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  }

  function fromBase64(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  async function digest(bytes) {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return toBase64(new Uint8Array(hash));
  }

  const routingHints = ['1.1.1.1', '8.8.8.8'];

  async function locate(address) {
    const response = await fetch(`https://ipapi.co/${encodeURIComponent(address)}/json/`);
    if (!response.ok) throw new Error(`Could not locate IP ${address}`);
    const location = await response.json();
    return { latitude: Number(location.latitude), longitude: Number(location.longitude) };
  }

  async function viewerLocation() {
    const response = await fetch('https://api64.ipify.org?format=json');
    if (!response.ok) throw new Error('Could not determine viewer IP');
    return locate((await response.json()).ip);
  }

  function distance(a, b) {
    const radians = (value) => value * Math.PI / 180;
    const latitude = radians(b.latitude - a.latitude);
    const longitude = radians(b.longitude - a.longitude);
    const h = Math.sin(latitude / 2) ** 2 + Math.cos(radians(a.latitude)) * Math.cos(radians(b.latitude)) * Math.sin(longitude / 2) ** 2;
    return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  function endpoint(node, path) {
    return `${String(node).replace(/\/$/, '')}${path}`;
  }

  class ISN {
    constructor({ nodes = [], replicas = 2, chunkSize = 1024 * 1024, location = null } = {}) {
      this.nodes = nodes;
      this.replicas = Math.max(1, replicas);
      this.chunkSize = chunkSize;
      this.location = location;
      if (!this.nodes.length) throw new Error('ISN requires configured storage hosts.');
    }

    async route() {
      const origin = this.location || await viewerLocation().catch(() => null);
      const locatedHints = await Promise.all(routingHints.map((hint) => locate(hint).catch(() => null)));
      const anchors = [origin, ...locatedHints].filter(Boolean);
      return this.nodes.map((node, index) => ({ node, index, distance: node.latitude && node.longitude && anchors.length ? Math.min(...anchors.map((anchor) => distance(node, anchor))) : index })).sort((a, b) => a.distance - b.distance).map(({ node }) => node);
    }

    async put(value) {
      const encoded = encode(value);
      const objectId = crypto.randomUUID();
      const chunks = [];
      for (let offset = 0; offset < encoded.bytes.length; offset += this.chunkSize) {
        const bytes = encoded.bytes.slice(offset, offset + this.chunkSize);
        chunks.push({ hash: await digest(bytes), data: toBase64(bytes) });
      }
      const manifest = { objectId, type: encoded.type, size: encoded.bytes.length, chunks: chunks.map(({ hash }) => hash) };
      const selected = (await this.route()).slice(0, Math.min(this.replicas, this.nodes.length)).map((node) => typeof node === 'string' ? node : node.endpoint);
      await Promise.all(selected.map((node) => fetch(endpoint(node, `/v1/objects/${objectId}`), {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(manifest)
      }).then(assertOk)));
      await Promise.all(chunks.map((chunk, index) => Promise.all(selected.map((node) => fetch(endpoint(node, `/v1/objects/${objectId}/chunks/${index}`), {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(chunk)
      }).then(assertOk)))));
      return objectId;
    }

    async get(objectId) {
      let manifest;
      let source;
      for (const configured of await this.route()) {
        const node = typeof configured === 'string' ? configured : configured.endpoint;
        try { const response = await fetch(endpoint(node, `/v1/objects/${encodeURIComponent(objectId)}`)); if (response.ok) { manifest = await response.json(); source = node; break; } } catch (_) { /* try the next public endpoint */ }
      }
      if (!manifest) throw new Error(`Object not found on configured ISN nodes: ${objectId}`);
      const parts = [];
      for (let index = 0; index < manifest.chunks.length; index += 1) {
        const response = await fetch(endpoint(source, `/v1/objects/${objectId}/chunks/${index}`));
        await assertOk(response);
        const chunk = await response.json();
        const bytes = fromBase64(chunk.data);
        if (await digest(bytes) !== manifest.chunks[index]) throw new Error(`Integrity check failed for chunk ${index}`);
        parts.push(bytes);
      }
      const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
      parts.reduce((offset, part) => { bytes.set(part, offset); return offset + part.length; }, 0);
      return decode(manifest.type, bytes);
    }
  }

  async function assertOk(response) {
    if (!response.ok) throw new Error(`ISN node returned HTTP ${response.status}`);
    return response;
  }

  root.ISN = ISN;
}(typeof self !== 'undefined' ? self : window));
