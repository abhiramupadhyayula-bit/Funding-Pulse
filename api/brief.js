// Funding Pulse backend
// 1. Pulls the last 7 days of Indian startup funding news from live RSS feeds
// 2. Sends the headlines to Gemini Flash to extract structured deals + weekly patterns
// 3. Ranks deals against Aarav's focus (sectors, stages, watchlist)
// 4. On Monday mornings (Vercel Cron) it can also email the brief

import defaultConfig from '../config.js';

const SECTORS = [
  'Fintech', 'SaaS', 'Deeptech/AI', 'Climate/EV', 'Healthtech', 'Edtech',
  'D2C/Consumer', 'Ecommerce/Quick commerce', 'Agritech', 'Logistics',
  'Mobility', 'Gaming/Media', 'Proptech', 'Other'
];
const STAGES = [
  'Pre-seed', 'Seed', 'Pre-Series A', 'Series A', 'Series B', 'Series C+',
  'Debt', 'Undisclosed'
];
const FUNDING_WORDS = /rais|fund|series [a-f]|seed|round|crore|cr\b|million|mn\b|invest|backed|led by|bridge/i;

const gnews = (q) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:7d')}&hl=en-IN&gl=IN&ceid=IN:en`;

function buildFeeds(cfg) {
  const feeds = [
    { name: 'Google News: funding', url: gnews('Indian startup raises funding') },
    { name: 'Google News: rounds', url: gnews('India startup "Series A" OR "seed round" OR "Series B"') },
    { name: 'Google News: crore rounds', url: gnews('startup raises crore led by') },
    { name: 'Inc42', url: 'https://inc42.com/feed/' },
    { name: 'Entrackr', url: 'https://entrackr.com/feed/' }
  ];
  // A targeted search for every watchlist company so none slip through
  for (const company of cfg.watchlist.slice(0, 10)) {
    feeds.push({ name: `Watchlist: ${company}`, url: gnews(`"${company}" funding`) });
  }
  return feeds;
}

// ---------- RSS helpers ----------
function decode(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function tag(chunk, t) {
  const m = chunk.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
  return m ? decode(m[1]) : '';
}

export function parseRss(xml, feedName) {
  return xml.split(/<item[\s>]/).slice(1).map((chunk) => {
    const publisher = tag(chunk, 'source') || feedName.replace(/^Google News.*|^Watchlist.*/, '') || 'News';
    let title = tag(chunk, 'title');
    if (publisher && title.endsWith(` - ${publisher}`)) title = title.slice(0, -(publisher.length + 3));
    return {
      title,
      link: tag(chunk, 'link'),
      date: new Date(tag(chunk, 'pubDate') || Date.now()),
      publisher: publisher || 'News'
    };
  });
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (FundingPulse brief bot)' },
      signal: AbortSignal.timeout(9000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const items = parseRss(await res.text(), feed.name);
    return { feed, items, ok: true };
  } catch (err) {
    return { feed, items: [], ok: false, error: String(err.message || err) };
  }
}

const keyOf = (title) =>
  title.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(Boolean).slice(0, 8).join(' ');

// ---------- Gemini ----------
async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error('GEMINI_API_KEY is not set. Add it in Vercel > Project > Settings > Environment Variables, then redeploy.');
  }
  const models = [process.env.GEMINI_MODEL, 'gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash'].filter(Boolean);
  let lastError = '';
  for (const model of models) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
        })
      }
    );
    if (res.status === 404) { lastError = `Model ${model} not found`; continue; }
    const data = await res.json();
    if (!res.ok) throw new Error(`Gemini error: ${data?.error?.message || res.status}`);
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    return { result: JSON.parse(clean), model };
  }
  throw new Error(lastError || 'No Gemini Flash model available');
}

function buildPrompt(headlines, cfg) {
  const list = headlines.map((h, i) => `[${i}] ${h.title} (${h.publisher}, ${h.date.toDateString()})`).join('\n');
  return `You are an analyst preparing a weekly Indian startup funding brief for a venture scout at a Bengaluru family office.

Below are numbered news headlines from the last 7 days. Many describe the same deal, and some are not funding announcements at all.

Tasks:
1. Find every distinct funding round raised by an Indian startup (equity or venture debt). Ignore IPOs, acquisitions, layoffs, results, and VC fund launches. Merge headlines that describe the same deal.
2. For each deal, extract the fields below. Use ONLY facts stated in the headlines. If something is not stated, use null (or [] for investors). Never invent investors or amounts.
3. Spot 3 to 5 patterns across the whole week (for example: a sector heating up, a stage dominating, an investor appearing repeatedly, unusually large rounds). Ground each pattern in specific deals. Give extra attention to the scout's focus areas.

Scout's focus sectors: ${cfg.sectors.join(', ') || 'none'}
Scout's focus stages: ${cfg.stages.join(', ') || 'none'}
Scout's watchlist companies: ${cfg.watchlist.join(', ') || 'none'}

Allowed sector values: ${SECTORS.join(' | ')}
Allowed stage values: ${STAGES.join(' | ')}

Return ONLY JSON in exactly this shape:
{
  "summary": "Two plain sentences on where capital moved this week.",
  "patterns": [ { "title": "short pattern name", "detail": "one or two sentences with evidence" } ],
  "deals": [
    {
      "company": "string",
      "one_liner": "what the company does, or empty string",
      "amount_text": "amount exactly as reported, e.g. Rs 50 Cr or $12 Mn, or null",
      "amount_usd_m": number in USD millions using 1 USD = 88 INR, or null,
      "stage": "one allowed stage value",
      "sector": "one allowed sector value",
      "lead_investors": ["names"],
      "source_ids": [headline numbers]
    }
  ]
}

Headlines:
${list}`;
}

// ---------- Ranking (plain code, so focus rules are predictable) ----------
const norm = (s) => String(s || '').toLowerCase().trim();

function rankDeals(deals, headlines, cfg) {
  return deals
    .filter((d) => d && d.company)
    .map((d) => {
      const ids = Array.isArray(d.source_ids) ? d.source_ids : [];
      const sources = ids
        .map((i) => headlines[i])
        .filter(Boolean)
        .filter((h, i, arr) => arr.findIndex((x) => x.link === h.link) === i)
        .slice(0, 3)
        .map((h) => ({ title: h.title, link: h.link, publisher: h.publisher }));
      const haystack = norm(d.company + ' ' + sources.map((s) => s.title).join(' '));
      const watchlistMatch = cfg.watchlist.find((w) => w && haystack.includes(norm(w))) || null;
      const sectorMatch = cfg.sectors.some((s) => norm(s) === norm(d.sector));
      const stageMatch = cfg.stages.some((s) => norm(s) === norm(d.stage));
      const priority = watchlistMatch ? 0 : sectorMatch && stageMatch ? 1 : sectorMatch ? 2 : 3;
      return {
        company: d.company,
        one_liner: d.one_liner || '',
        amount_text: d.amount_text || null,
        amount_usd_m: typeof d.amount_usd_m === 'number' ? d.amount_usd_m : null,
        stage: d.stage || 'Undisclosed',
        sector: d.sector || 'Other',
        lead_investors: Array.isArray(d.lead_investors) ? d.lead_investors : [],
        sources,
        watchlistMatch,
        sectorMatch,
        stageMatch,
        inFocus: priority <= 2,
        priority
      };
    })
    .sort((a, b) => a.priority - b.priority || (b.amount_usd_m || 0) - (a.amount_usd_m || 0));
}

function sectorStats(deals) {
  const map = {};
  for (const d of deals) {
    map[d.sector] ??= { sector: d.sector, deals: 0, usd_m: 0 };
    map[d.sector].deals += 1;
    map[d.sector].usd_m += d.amount_usd_m || 0;
  }
  return Object.values(map).sort((a, b) => b.deals - a.deals || b.usd_m - a.usd_m);
}

// ---------- Email (optional) ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendEmail(brief, siteUrl) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.BRIEF_EMAIL_TO;
  if (!key || !to) return 'skipped (RESEND_API_KEY or BRIEF_EMAIL_TO not set)';
  const focus = brief.deals.filter((d) => d.inFocus).slice(0, 15);
  const row = (d) => `<li><b>${esc(d.company)}</b>${d.watchlistMatch ? ' ⚠️ watchlist' : ''}: ${esc(d.amount_text || 'Undisclosed')}, ${esc(d.stage)}, ${esc(d.sector)}${d.lead_investors.length ? `, led by ${esc(d.lead_investors.join(', '))}` : ''}</li>`;
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px">
    <h2>Funding Pulse: ${esc(brief.weekFrom)} to ${esc(brief.weekTo)}</h2>
    <p>${esc(brief.summary)}</p>
    <h3>Patterns</h3><ul>${brief.patterns.map((p) => `<li><b>${esc(p.title)}</b>: ${esc(p.detail)}</li>`).join('')}</ul>
    <h3>Your focus deals</h3><ul>${focus.map(row).join('') || '<li>None this week</li>'}</ul>
    <p><a href="${esc(siteUrl)}">Open the full brief</a></p></div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.BRIEF_EMAIL_FROM || 'Funding Pulse <onboarding@resend.dev>',
      to: to.split(',').map((s) => s.trim()),
      subject: `Funding Pulse: ${brief.deals.length} deals this week`,
      html
    })
  });
  return res.ok ? 'sent' : `failed (${res.status})`;
}

// ---------- Main ----------
function cleanConfig(input) {
  const list = (v) => (Array.isArray(v) ? v : [])
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
  return { sectors: list(input?.sectors), stages: list(input?.stages), watchlist: list(input?.watchlist) };
}

export async function buildBrief(cfg) {
  const fetched = await Promise.all(buildFeeds(cfg).map(fetchFeed));
  const weekAgo = Date.now() - 8 * 24 * 3600 * 1000;
  const seen = new Set();
  const headlines = fetched
    .flatMap((f) => f.items)
    .filter((h) => h.title && !isNaN(h.date) && h.date.getTime() >= weekAgo && FUNDING_WORDS.test(h.title))
    .sort((a, b) => b.date - a.date)
    .filter((h) => { const k = keyOf(h.title); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 120);

  if (!headlines.length) {
    throw new Error('No funding headlines could be fetched from the live sources right now. Try Refresh in a minute.');
  }

  const { result, model } = await callGemini(buildPrompt(headlines, cfg));
  const deals = rankDeals(Array.isArray(result.deals) ? result.deals : [], headlines, cfg);
  const fmt = (d) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

  return {
    generatedAt: new Date().toISOString(),
    weekFrom: fmt(new Date(Date.now() - 7 * 24 * 3600 * 1000)),
    weekTo: fmt(new Date()),
    config: cfg,
    summary: result.summary || '',
    patterns: Array.isArray(result.patterns) ? result.patterns.slice(0, 6) : [],
    deals,
    sectorStats: sectorStats(deals),
    totals: {
      deals: deals.length,
      disclosedUsdM: Math.round(deals.reduce((s, d) => s + (d.amount_usd_m || 0), 0)),
      watchlistHits: deals.filter((d) => d.watchlistMatch).length,
      headlinesScanned: headlines.length
    },
    sources: fetched.map((f) => ({ name: f.feed.name, ok: f.ok, items: f.items.length })),
    model
  };
}

export default async function handler(req, res) {
  try {
    const isPost = req.method === 'POST';
    const cfg = isPost ? cleanConfig(req.body?.config) : cleanConfig(defaultConfig);
    const brief = await buildBrief(cfg);

    // Monday cron run: optionally email the brief
    const isCron = req.query?.cron === '1';
    const secret = process.env.CRON_SECRET;
    const authorised = !secret || req.headers.authorization === `Bearer ${secret}`;
    if (isCron && authorised) {
      brief.email = await sendEmail(brief, `https://${req.headers.host}`);
    }

    res.setHeader('Cache-Control', isPost || isCron ? 'no-store' : 's-maxage=1800, stale-while-revalidate=3600');
    res.status(200).json(brief);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ error: String(err.message || err) });
  }
}
