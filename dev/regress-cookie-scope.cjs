const { createWorld } = require('./sw-harness.cjs');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const w = createWorld({ frames: { 1: [{ frameId: 0, url: 'https://www.skool.com/c/x?md=abc', documentId: 'doc-top' }] } });
  const jar = [
    { domain: '.bank.co.uk', name: 'SESSION', value: 'bank-secret' },
    { domain: 'media.example.co.uk', name: 'cdn', value: 'ok' },
    { domain: 'd111.cloudfront.net', name: 'CloudFront-Signature', value: 'sigA' },
    { domain: 'd222.cloudfront.net', name: 'CloudFront-Signature', value: 'sigB' },
  ];
  const calls = [];
  w.chrome.cookies.getAll = async (q) => { calls.push(JSON.stringify(q)); return jar.filter((c) => (c.domain.replace(/^\./, '') + '').endsWith(q.domain) && !q.partitionKey); };
  let added = [];
  const orig = w.chrome.declarativeNetRequest.updateSessionRules;
  w.chrome.declarativeNetRequest.updateSessionRules = async (o) => { if (o.addRules?.length) added.push(...o.addRules); return orig(o); };
  w.startSW(); await tick();
  for (const url of ['https://media.example.co.uk/v/master.m3u8', 'https://d222.cloudfront.net/v/master.m3u8']) {
    added = [];
    await w.popup({ type: 'popup:download', tabId: 1, pageUrl: 'https://www.skool.com/c/x?md=abc', quality: 'highest', folder: '', saveAs: false, item: { kind: 'hls', name: 'x', url } });
    await tick(200);
    const r = added.find((r) => r.condition.requestDomains[0] !== 'loom.com' && r.condition.requestDomains[0] !== 'skool.com' && r.condition.requestDomains[0] !== 'b-cdn.net');
    console.log(url, '-> rule domains', JSON.stringify(r.condition.requestDomains), 'cookie:', r.action.requestHeaders.find((h) => h.header === 'cookie')?.value);
  }
  process.exit(0);
})();
