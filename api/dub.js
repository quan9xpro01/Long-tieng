const crypto = require('crypto');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

module.exports = async (req, res) => {
  const a = req.query.a;
  try {
    if (a === 'tr') return res.status(200).json(await getTranscript(String(req.query.v || '')));
    if (a === 'tl') {
      let b = req.body;
      if (typeof b === 'string') b = JSON.parse(b);
      return res.status(200).json({ out: await translate(b && b.lines) });
    }
    if (a === 'tts') {
      const buf = await tts(req.query.text, String(req.query.voice || ''));
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.status(200).send(buf);
    }
    return res.status(400).json({ error: 'Yêu cầu không hợp lệ' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200) });
  }
};

// ---------- Phụ đề YouTube ----------
async function getTranscript(id) {
  if (!/^[\w-]{11}$/.test(id)) throw new Error('ID video không hợp lệ');
  const r = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip',
    },
    body: JSON.stringify({
      context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34, hl: 'en', gl: 'US' } },
      videoId: id,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
  });
  const j = await r.json();
  const status = j.playabilityStatus && j.playabilityStatus.status;
  const tracks = (((j.captions || {}).playerCaptionsTracklistRenderer || {}).captionTracks) || [];
  if (!tracks.length) {
    throw new Error(status && status !== 'OK' ? 'YouTube từ chối (' + status + ')' : 'Video không có phụ đề');
  }
  const t = tracks.find((x) => x.languageCode === 'vi') || tracks.find((x) => x.kind !== 'asr') || tracks[0];
  const c = await fetch(t.baseUrl.replace(/&fmt=[^&]*/g, '') + '&fmt=json3', { headers: { 'User-Agent': UA } });
  const txt = (await c.text()).trim();
  if (!txt) throw new Error('YouTube trả về phụ đề rỗng');
  const segs = merge(txt.startsWith('{') ? (JSON.parse(txt).events || []) : parseXml(txt));
  if (!segs.length) throw new Error('Phụ đề trống');
  return { lang: t.languageCode, segs };
}

function unesc(s) {
  const f = (x) => x
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return f(f(s.replace(/<[^>]+>/g, '')));
}

function parseXml(x) {
  const ev = [];
  let m;
  const re1 = /<text start="([\d.]+)"(?: dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/g;
  while ((m = re1.exec(x))) ev.push({ tStartMs: +m[1] * 1000, dDurationMs: (+m[2] || 2) * 1000, segs: [{ utf8: unesc(m[3]) }] });
  if (ev.length) return ev;
  const re2 = /<p t="(\d+)"(?: d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
  while ((m = re2.exec(x))) ev.push({ tStartMs: +m[1], dDurationMs: +m[2] || 2000, segs: [{ utf8: unesc(m[3]) }] });
  return ev;
}

function merge(events) {
  const out = [];
  let cur = null;
  for (const e of events) {
    if (!e.segs) continue;
    const t = e.segs.map((x) => x.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const s = e.tStartMs / 1000;
    const en = s + (e.dDurationMs || 2000) / 1000;
    if (cur && (s - cur.e > 1.5 || cur.t.length > 140)) { out.push(cur); cur = null; }
    if (cur) { cur.t += ' ' + t; cur.e = Math.max(cur.e, en); } else cur = { s, e: en, t };
    if (/[.!?…。]$/.test(cur.t)) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.map((x) => ({ s: Math.round(x.s * 10) / 10, e: Math.round(x.e * 10) / 10, t: x.t }));
}

// ---------- Dịch (Google Translate, miễn phí) ----------
async function translate(lines) {
  if (!Array.isArray(lines) || lines.length > 40) throw new Error('Dữ liệu dịch không hợp lệ');
  return Promise.all(lines.map(async (l) => {
    const q = String(l).slice(0, 500);
    for (let k = 0; k < 2; k++) {
      try {
        const r = await fetch('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=vi&dt=t&q=' + encodeURIComponent(q));
        const j = await r.json();
        return j[0].map((x) => x[0] || '').join('');
      } catch (e) { /* thử lại */ }
    }
    return '';
  }));
}

// ---------- Giọng Edge TTS ----------
async function tts(text, voice) {
  const hosts = [
    'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1?Ocp-Apim-Subscription-Key=' + TOKEN,
    'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=' + TOKEN,
  ];
  let last = new Error('Không có máy chủ');
  for (const h of hosts) {
    try { return await ttsOnce(h, text, voice); } catch (e) { last = e; }
  }
  throw new Error(last.message + ' (đã thử cả 2 máy chủ)');
}

function ttsOnce(base, text, voice) {
  return new Promise((resolve, reject) => {
    text = String(text || '').trim().slice(0, 800);
    if (!text) return reject(new Error('Thiếu nội dung'));
    if (!/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(voice)) return reject(new Error('Giọng không hợp lệ'));
    const WebSocket = require('ws');
    let s = BigInt(Math.floor(Date.now() / 1000) + 11644473600);
    s -= s % 300n;
    const gec = crypto.createHash('sha256').update((s * 10000000n).toString() + TOKEN, 'ascii').digest('hex').toUpperCase();
    const url = base
      + '&Sec-MS-GEC=' + gec
      + '&Sec-MS-GEC-Version=1-143.0.3650.75'
      + '&ConnectionId=' + crypto.randomUUID().replace(/-/g, '');
    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        'Ocp-Apim-Subscription-Key': TOKEN,
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent': UA,
      },
    });
    const chunks = [];
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.terminate(); } catch (e) { /* bỏ qua */ }
      if (err) return reject(err);
      if (!chunks.length) return reject(new Error('Không nhận được âm thanh'));
      resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => finish(new Error('Hết thời gian chờ')), 12000);
    ws.on('error', (e) => finish(new Error(e.message)));
    ws.on('close', () => finish());
    ws.on('open', () => {
      const ts = new Date().toISOString();
      const esc = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
      ws.send('X-Timestamp:' + ts + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n'
        + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}');
      ws.send('X-RequestId:' + crypto.randomUUID().replace(/-/g, '') + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + ts + '\r\nPath:ssml\r\n\r\n'
        + "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='vi-VN'><voice name='" + voice + "'>"
        + "<prosody pitch='+0Hz' rate='+0%' volume='+0%'>" + esc + '</prosody></voice></speak>');
    });
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        if (data.toString().includes('Path:turn.end')) finish();
        return;
      }
      const len = data.readUInt16BE(0);
      const head = data.slice(2, 2 + len).toString();
      if (head.includes('Path:audio')) chunks.push(data.slice(2 + len));
    });
  });
}
