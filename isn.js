/* PN browser client: peer-to-peer storage through WebTorrent. */
(function (root) {
  const TRACKERS = [
    'wss://tracker.btorrent.xyz',
    'wss://tracker.fastcast.nz',
    'wss://tracker.openwebtorrent.com'
  ];
  let clientPromise;
  function client() {
    if (root.WebTorrent) return Promise.resolve(root._pnClient || (root._pnClient = new root.WebTorrent()));
    if (!clientPromise) clientPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/webtorrent@latest/webtorrent.min.js';
      script.onload = () => resolve(root._pnClient || (root._pnClient = new root.WebTorrent()));
      script.onerror = () => reject(new Error('PN could not load its browser peer transport'));
      document.head.appendChild(script);
    });
    return clientPromise;
  }

  class PN {
    async put(value) {
      const torrentClient = await client();
      const payload = JSON.stringify({ type: typeof value === 'string' ? 'text' : 'json', value });
      return new Promise((resolve, reject) => {
        torrentClient.seed(new File([payload], 'pn-object.json', { type: 'application/json' }), { announce: TRACKERS }, (torrent) => resolve(torrent.magnetURI));
        torrentClient.on('error', reject);
      });
    }

    async get(magnetURI) {
      const torrentClient = await client();
      return new Promise((resolve, reject) => {
        torrentClient.add(magnetURI, { announce: TRACKERS }, (torrent) => {
          torrent.files[0].arrayBuffer().then((buffer) => {
            const object = JSON.parse(new TextDecoder().decode(buffer));
            resolve(object.type === 'text' ? object.value : object.value);
          }).catch(reject);
        });
        torrentClient.on('error', reject);
      });
    }
  }

  root.PN = PN;
  PN.trackers = TRACKERS.slice();
  root.ISN = PN;
}(typeof self !== 'undefined' ? self : window));
