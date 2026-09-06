#!/usr/bin/env node
/**
 * Ambient — Week 25 burst yuk testi
 *
 * Uc asama:
 *   1. BASELINE : 5 sirali istek, sakin durum
 *   2. BURST    : N istek AYNI ANDA (varsayilan 20)
 *   3. RECOVERY : 5 sirali istek, burst sonrasi toparlanma
 *
 * Olculenler: latency p50/p95, hata orani, hata kodlari,
 * burst sirasinda kuyruk davranisi, recovery suresi.
 *
 * Maliyet: kisa promptlar + dusuk max_tokens, tam calisma ~1-2 cent.
 *
 * Kullanim:
 *   export AMBIENT_API_KEY="anahtar"
 *   node burst-test.mjs               # 20 paralel
 *   node burst-test.mjs 40            # 40 paralel
 *   AMBIENT_MODEL="z-ai/glm-5.2" node burst-test.mjs
 */

const API = "https://api.ambient.xyz/v1/chat/completions";
const KEY = process.env.AMBIENT_API_KEY;
const MODEL = process.env.AMBIENT_MODEL ?? "deepseek/deepseek-v4-flash-0731";
const BURST = parseInt(process.argv[2] || "20", 10);
const SEQ = 5;              // baseline ve recovery istek sayisi
const MAX_TOKENS = 60;      // maliyeti dusuk tutmak icin

if (!KEY) {
  console.error('HATA: once  export AMBIENT_API_KEY="..."  yap.');
  process.exit(1);
}

const PROMPT = "Name one European capital city. Just the name.";

/** Tek istek: streaming, TTFT ve toplam sure olcer. */
async function one(label) {
  const t0 = performance.now();
  let ttft = null, text = "", chunks = 0;
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODEL, max_tokens: MAX_TOKENS, stream: true,
        messages: [{ role: "user", content: PROMPT }],
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const body = await res.text();
      let msg = body.slice(0, 70);
      try { msg = JSON.parse(body).error?.message ?? msg; } catch {}
      return { label, ok: false, status: res.status, msg, total: (performance.now() - t0) / 1000 };
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const l of lines) {
        const t = l.trim();
        if (!t.startsWith("data:")) continue;
        const p = t.slice(5).trim();
        if (p === "[DONE]") continue;
        try {
          const d = JSON.parse(p).choices?.[0]?.delta;
          if (d?.content) {
            if (ttft === null) ttft = (performance.now() - t0) / 1000;
            text += d.content; chunks++;
          }
        } catch {}
      }
    }
    // Icerik hic gelmediyse akis yarim kalmis olabilir
    const truncated = chunks === 0;
    return { label, ok: true, ttft, total: (performance.now() - t0) / 1000, chunks, truncated };
  } catch (err) {
    return {
      label, ok: false,
      status: err.name === "TimeoutError" ? "TIMEOUT" : "ERR",
      msg: err.message.slice(0, 60),
      total: (performance.now() - t0) / 1000,
    };
  }
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (n) => (n == null ? " n/a" : n.toFixed(2) + "s");

function report(name, results, wallClock) {
  const ok = results.filter((r) => r.ok);
  const fail = results.filter((r) => !r.ok);
  const ttfts = ok.map((r) => r.ttft).filter((x) => x != null);
  const totals = ok.map((r) => r.total);
  const empty = ok.filter((r) => r.truncated).length;

  console.log(`\n--- ${name} ---`);
  console.log(`  istek: ${results.length} | basarili: ${ok.length} | hatali: ${fail.length} | bos-akis: ${empty}`);
  if (wallClock) console.log(`  duvar saati: ${fmt(wallClock)} (paralel toplam sure)`);
  if (ttfts.length) {
    console.log(`  TTFT   p50 ${fmt(pct(ttfts, 50))} | p95 ${fmt(pct(ttfts, 95))} | min ${fmt(Math.min(...ttfts))} | max ${fmt(Math.max(...ttfts))}`);
    console.log(`  toplam p50 ${fmt(pct(totals, 50))} | p95 ${fmt(pct(totals, 95))} | max ${fmt(Math.max(...totals))}`);
  }
  if (fail.length) {
    const codes = {};
    for (const f of fail) codes[`${f.status}`] = (codes[`${f.status}`] || 0) + 1;
    console.log(`  hata kodlari: ${Object.entries(codes).map(([k, v]) => `${k}x${v}`).join(", ")}`);
    console.log(`  ornek mesaj: "${fail[0].msg}"`);
  }
  return { ok: ok.length, fail: fail.length, empty, p50: pct(ttfts, 50), p95: pct(ttfts, 95) };
}

(async () => {
  console.log(`Ambient burst testi | ${new Date().toISOString()}`);
  console.log(`model: ${MODEL} | burst: ${BURST} paralel | max_tokens: ${MAX_TOKENS}`);

  // 1. BASELINE
  const base = [];
  for (let i = 1; i <= SEQ; i++) {
    const r = await one(`base${i}`);
    console.log(`  baseline #${i}: ${r.ok ? `ok TTFT ${fmt(r.ttft)}` : `FAIL ${r.status}`}`);
    base.push(r);
    await new Promise((s) => setTimeout(s, 400));
  }
  const baseStats = report("BASELINE (sirali)", base);

  // 2. BURST
  console.log(`\n>>> ${BURST} istek ayni anda gonderiliyor...`);
  const t0 = performance.now();
  const burst = await Promise.all(Array.from({ length: BURST }, (_, i) => one(`burst${i + 1}`)));
  const wall = (performance.now() - t0) / 1000;
  const burstStats = report(`BURST (${BURST} paralel)`, burst, wall);

  // 3. RECOVERY
  console.log(`\n>>> burst bitti, toparlanma olculuyor...`);
  const rec = [];
  for (let i = 1; i <= SEQ; i++) {
    const r = await one(`rec${i}`);
    console.log(`  recovery #${i}: ${r.ok ? `ok TTFT ${fmt(r.ttft)}` : `FAIL ${r.status}`}`);
    rec.push(r);
    await new Promise((s) => setTimeout(s, 400));
  }
  const recStats = report("RECOVERY (sirali)", rec);

  // KARSILASTIRMA
  console.log(`\n=== KARSILASTIRMA ===`);
  console.log("asama".padEnd(14) + "basari".padEnd(10) + "TTFT p50".padEnd(11) + "TTFT p95");
  const row = (n, s, total) => console.log(n.padEnd(14) + `${s.ok}/${total}`.padEnd(10) + fmt(s.p50).padEnd(11) + fmt(s.p95));
  row("baseline", baseStats, SEQ);
  row("burst", burstStats, BURST);
  row("recovery", recStats, SEQ);

  if (baseStats.p50 && burstStats.p50) {
    const x = (burstStats.p50 / baseStats.p50).toFixed(1);
    console.log(`\nBurst sirasinda TTFT p50 ${x}x degisti.`);
  }
  if (baseStats.p50 && recStats.p50) {
    const x = (recStats.p50 / baseStats.p50).toFixed(1);
    console.log(`Recovery TTFT p50 baseline'in ${x}x'i (1.0 = tam toparlanma).`);
  }
  console.log(`\nCalistirma: ${new Date().toLocaleString()}`);
})();
