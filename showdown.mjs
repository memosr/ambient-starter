#!/usr/bin/env node
/**
 * Ambient — Week 26 model showdown
 *
 * Amac: modelleri GERCEKTEN ayiran sorular. Onceki benchmark'ta
 * herkes 3/3 yapiyordu, yani sorular kolay ve ayirt edici degildi.
 *
 * 6 challenge, hepsi otomatik puanlanabilir:
 *   1. math      : cok adimli aritmetik, tek dogru sayi
 *   2. trap      : yuzeysel cevabin yanlis oldugu mantik sorusu
 *   3. instruct  : tam olarak 5 kelime, sadece kucuk harf
 *   4. json      : gecerli JSON, belirli alanlar
 *   5. longctx   : uzun metne gomulu bilgiyi bulma
 *   6. format    : sirali liste, tam 3 madde, her biri tek kelime
 *
 * Token butcesi: reasoning modelleri butceyi once dusunmeye harciyor,
 * o yuzden bol veriyoruz. Aksi halde GLM gibi modeller haksiz yere
 * bos donuyor (bkz. finish_reason: length).
 *
 * Kullanim:
 *   export AMBIENT_API_KEY="anahtar"
 *   node showdown.mjs          # her challenge 3 kez
 *   node showdown.mjs 5
 */

const API = "https://api.ambient.xyz/v1/chat/completions";
const KEY = process.env.AMBIENT_API_KEY;
const RUNS = parseInt(process.argv[2] || "3", 10);
const MAX_TOKENS = 1500;   // reasoning modellerine adil davranmak icin bol

if (!KEY) {
  console.error('HATA: once  export AMBIENT_API_KEY="..."  yap.');
  process.exit(1);
}

const MODELS = [
  "qwen/qwen3.6-27b",
  "qwen/qwen3.8-27b",
  "z-ai/glm-5.2",
];

/** Her challenge: prompt + otomatik puanlayici. */
const CHALLENGES = [
  {
    id: "math",
    prompt:
      "A shop sells pens at 7 for 12 dollars and notebooks at 3 for 11 dollars. " +
      "I buy 21 pens and 9 notebooks, then get a 15 percent discount on the total. " +
      "What do I pay? Give the final number in dollars.",
    // 21 kalem = 3 paket * 12 = 36 ; 9 defter = 3 paket * 11 = 33 ; toplam 69 ; %15 indirim -> 58.65
    score: (t) => /58[.,]65/.test(t),
    expect: "58.65",
  },
  {
    id: "trap",
    prompt:
      "A bat and a ball cost 1.10 dollars in total. The bat costs 1.00 dollar more than the ball. " +
      "How much does the ball cost? Answer with just the amount.",
    // Klasik tuzak: sezgisel cevap 0.10, dogru cevap 0.05
    score: (t) => /0[.,]05|5\s*cents?\b/i.test(t) && !/\b0[.,]10\b/.test(t.replace(/1[.,]10/g, "")),
    expect: "0.05",
  },
  {
    id: "instruct",
    prompt:
      "Describe the ocean in exactly five words, all lowercase, no punctuation at all. " +
      "Output only those five words.",
    score: (t) => {
      const s = t.trim();
      if (/[.,!?;:'"()\[\]]/.test(s)) return false;
      if (s !== s.toLowerCase()) return false;
      return s.split(/\s+/).filter(Boolean).length === 5;
    },
    expect: "5 kelime, kucuk harf, noktalama yok",
  },
  {
    id: "json",
    prompt:
      'Return only valid JSON, no markdown fences, no explanation, with exactly these keys: ' +
      '"city" (string), "population" (number), "country" (string). Use Tokyo as the city.',
    score: (t) => {
      const s = t.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      try {
        const o = JSON.parse(s);
        return (
          typeof o.city === "string" &&
          typeof o.population === "number" &&
          typeof o.country === "string" &&
          Object.keys(o).length === 3
        );
      } catch { return false; }
    },
    expect: "3 anahtarli gecerli JSON",
  },
  {
    id: "longctx",
    prompt:
      "Read the following log and answer the question at the end.\n\n" +
      Array.from({ length: 40 }, (_, i) =>
        `entry ${i + 1}: status=ok latency=${100 + i}ms region=eu-west node=n${i % 7}`
      ).join("\n").replace("entry 27: status=ok", "entry 27: status=FAILED") +
      "\n\nQuestion: which entry number has a status other than ok? Answer with just the number.",
    score: (t) => /\b27\b/.test(t),
    expect: "27",
  },
  {
    id: "format",
    prompt:
      "List exactly three primary colors as a numbered list. " +
      "Each line must be the number, a period, a space, then a single word. Nothing else.",
    score: (t) => {
      const lines = t.trim().split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length !== 3) return false;
      return lines.every((l, i) => new RegExp(`^${i + 1}\\.\\s+\\w+$`).test(l));
    },
    expect: "3 satir, '1. kelime' formatinda",
  },
];

async function ask(model, prompt) {
  const t0 = performance.now();
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model, max_tokens: MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    const body = await res.text();
    if (!res.ok) {
      let msg = body.slice(0, 70);
      try { msg = JSON.parse(body).error?.message ?? msg; } catch {}
      return { ok: false, status: res.status, msg, sec: (performance.now() - t0) / 1000 };
    }
    const d = JSON.parse(body);
    const m = d.choices?.[0]?.message ?? {};
    return {
      ok: true,
      text: m.content ?? "",
      finish: d.choices?.[0]?.finish_reason,
      reasoningTokens: d.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
      completionTokens: d.usage?.completion_tokens ?? 0,
      sec: (performance.now() - t0) / 1000,
    };
  } catch (err) {
    return { ok: false, status: err.name === "TimeoutError" ? "TIMEOUT" : "ERR", msg: err.message.slice(0, 60), sec: (performance.now() - t0) / 1000 };
  }
}

const fmt = (n) => (n == null ? " n/a" : n.toFixed(2) + "s");
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

(async () => {
  console.log(`Ambient model showdown | ${new Date().toISOString()}`);
  console.log(`${MODELS.length} model x ${CHALLENGES.length} challenge x ${RUNS} kosu | max_tokens ${MAX_TOKENS}\n`);
  const grid = {};

  for (const model of MODELS) {
    console.log(`########## ${model} ##########`);
    grid[model] = {};
    for (const c of CHALLENGES) {
      let pass = 0, fail = 0, err = 0;
      const times = [];
      for (let i = 1; i <= RUNS; i++) {
        const r = await ask(model, c.prompt);
        if (!r.ok) {
          err++;
          console.log(`  ${c.id.padEnd(9)} #${i} ERR ${r.status} ${r.msg}`);
        } else if (!r.text.trim()) {
          fail++;
          console.log(`  ${c.id.padEnd(9)} #${i} BOS (finish: ${r.finish}, reasoning ${r.reasoningTokens}/${r.completionTokens} token)`);
        } else {
          const good = c.score(r.text);
          good ? pass++ : fail++;
          times.push(r.sec);
          const prev = r.text.trim().replace(/\n/g, " ").slice(0, 42);
          console.log(`  ${c.id.padEnd(9)} #${i} ${good ? "PASS" : "FAIL"} ${fmt(r.sec)} r${r.reasoningTokens} "${prev}"`);
        }
      }
      grid[model][c.id] = { pass, fail, err, t: avg(times) };
    }
    console.log("");
  }

  // Skor tablosu
  console.log("=== SKOR TABLOSU (dogru / kosu) ===");
  const head = "challenge".padEnd(11) + MODELS.map((m) => m.slice(0, 17).padEnd(19)).join("");
  console.log(head);
  for (const c of CHALLENGES) {
    let line = c.id.padEnd(11);
    for (const m of MODELS) {
      const g = grid[m][c.id];
      line += `${g.pass}/${RUNS}${g.err ? ` (${g.err}e)` : ""}`.padEnd(8) + fmt(g.t).padEnd(11);
    }
    console.log(line);
  }

  console.log("\n=== TOPLAM ===");
  for (const m of MODELS) {
    const p = CHALLENGES.reduce((s, c) => s + grid[m][c.id].pass, 0);
    const total = CHALLENGES.length * RUNS;
    const t = avg(CHALLENGES.map((c) => grid[m][c.id].t).filter(Boolean));
    console.log(`${m.padEnd(22)} ${p}/${total} dogru | ort ${fmt(t)}`);
  }
  console.log(`\nCalistirma: ${new Date().toLocaleString()}`);
})();
