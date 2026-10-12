const SYMBOLS = [
  ["^IXIC", "NASDAQ"],
  ["BTC-USD", "BTC/USD"],
  ["GBPUSD=X", "GBP/USD"],
  ["EURUSD=X", "EUR/USD"],
];

async function getGoldSpotQuote() {
  const response = await fetch("https://xaus.com/api/v1/spot?compact=1", {
    headers: {
      "User-Agent": "SG-Upper-Ticker/1.0",
      "Accept": "application/json"
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("XAU/USD spot source returned " + response.status);

  const payload = await response.json();
  const price = Number(payload?.spot_usd_oz ?? payload?.xau?.price);
  const state = String(payload?.data_state?.status || "").toLowerCase();
  const quoteAtRaw = payload?.data_state?.as_of || payload?.updated_at || null;
  const quoteAtMs = quoteAtRaw ? new Date(quoteAtRaw).getTime() : NaN;
  const ageSeconds = Number.isFinite(quoteAtMs)
    ? Math.max(0, Math.floor((Date.now() - quoteAtMs) / 1000))
    : Number(payload?.data_state?.age_seconds);
  if (!Number.isFinite(price) || price <= 0) throw new Error("XAU/USD spot quote missing from source");
  if (state === "unavailable") throw new Error("XAU/USD spot source reports unavailable");

  const timestampKnown = Number.isFinite(quoteAtMs);
  const isStale = state === "stale" || (timestampKnown ? ageSeconds > 180 : true);
  return {
    pair: "XAU/USD",
    price,
    changePct: null,
    source: "XAUS",
    quoteAt: timestampKnown ? new Date(quoteAtMs).toISOString() : null,
    ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null,
    marketState: null,
    freshness: isStale ? "stale" : "fresh",
    isStale
  };
}

const IMPACT_ORDER = { High: 0, Medium: 1, Low: 2 };
let calendarDebug = { feedErrors: [] };
let newsCache = { value: null, expiresAt: 0 };

async function getQuote(symbol, pair) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=1d&interval=5m";
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 SG-Upper-Ticker/1.0", "Accept": "application/json" },
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error("Yahoo Finance returned " + response.status + " for " + pair);

  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const meta = result?.meta;
  const timestamps = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const valid = closes.filter(value => typeof value === "number" && Number.isFinite(value));
  const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : valid.at(-1);
  const previous = typeof meta?.chartPreviousClose === "number" ? meta.chartPreviousClose :
    (typeof meta?.previousClose === "number" ? meta.previousClose : valid[0]);
  if (!Number.isFinite(price)) throw new Error("Quote missing for " + pair);

  const sourceTimestamp = Number(meta?.regularMarketTime) || Number(timestamps.at(-1));
  const quoteAtMs = Number.isFinite(sourceTimestamp) && sourceTimestamp > 0 ? sourceTimestamp * 1000 : NaN;
  const timestampKnown = Number.isFinite(quoteAtMs);
  const ageSeconds = timestampKnown ? Math.max(0, Math.floor((Date.now() - quoteAtMs) / 1000)) : null;
  const marketState = String(meta?.marketState || "").toUpperCase() || null;
  const isContinuousMarket = symbol === "BTC-USD" || symbol === "GBPUSD=X" || symbol === "EURUSD=X";
  // Forex and crypto trade continuously; the index is only expected to refresh while its market is open.
  const staleThresholdSeconds = isContinuousMarket ? 15 * 60 : 20 * 60;
  const isMarketClosed = !isContinuousMarket && ["CLOSED", "CLOSE"].includes(marketState);
  const isStale = !timestampKnown || (!isMarketClosed && ageSeconds > staleThresholdSeconds);

  return {
    pair,
    price,
    changePct: Number.isFinite(previous) && previous !== 0 ? ((price - previous) / previous) * 100 : null,
    source: "Yahoo Finance",
    quoteAt: timestampKnown ? new Date(quoteAtMs).toISOString() : null,
    ageSeconds,
    marketState,
    freshness: isStale ? "stale" : (isMarketClosed ? "market-closed" : "fresh"),
    isStale
  };
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function htmlCellText(row, cellName) {
  const pattern = new RegExp(`<td\\b(?=[^>]*class=["'][^"']*\\bcalendar__${cellName}\\b)[^>]*>([\\s\\S]*?)<\\/td>`, "i");
  const match = row.match(pattern);
  if (!match) return "";
  return decodeHtml(match[1]
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

// The public weekly JSON feed omits released actuals. Enrich it from the calendar page.
async function getPublishedCalendarValues() {
  const response = await fetch("https://calendar.forexfactory.com/calendar?week=this", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache"
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("ForexFactory calendar page returned " + response.status);
  const html = await response.text();
  const rows = html.match(/<tr\b[^>]*class=["'][^"']*calendar__row[^"']*["'][^>]*>[\s\S]*?<\/tr>/gi) || [];
  calendarDebug = { status: response.status, htmlLength: html.length, rowCount: rows.length, htmlStart: html.slice(0, 120) };
  const values = new Map();
  for (const row of rows) {
    const title = htmlCellText(row, "event");
    const country = htmlCellText(row, "currency").toUpperCase();
    if (!title || country !== "USD") continue;
    const actual = htmlCellText(row, "actual");
    const forecast = htmlCellText(row, "forecast");
    const previous = htmlCellText(row, "previous");
    if (![actual, forecast, previous].some(value => value !== "")) continue;
    values.set(title.trim().toLowerCase() + "|" + country, { actual, forecast, previous });
  }
  calendarDebug.valueCount = values.size;
  calendarDebug.sampleRow = rows[0] ? rows[0].slice(0, 300) : "";
  return values;
}

async function getNews() {
  const now = Date.now();
  // Keep the upstream feed within its strict rate limit. The browser polls this API
  // frequently, so reuse the last successful calendar for five minutes per warm instance.
  if (newsCache.value && now < newsCache.expiresAt) return newsCache.value;

  const thisWeekUrl = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
  const nextWeekUrl = "https://nfs.faireconomy.media/ff_calendar_nextweek.json";
  const fetchCalendar = async url => {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "application/json,text/plain,*/*",
        "Accept-Language": "en-US,en;q=0.9"
      },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error("ForexFactory calendar returned " + response.status);
    return response.json();
  };
  const dayKey = value => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(value);
  const normalize = items => items.flatMap(item => {
    if (String(item.currency || item.country || "").toUpperCase() !== "USD") return [];
    if (!["High", "Medium", "Low"].includes(item.impact)) return [];
    if (!item.title || !item.date) return [];
    const timestamp = new Date(item.date).getTime();
    if (!Number.isFinite(timestamp)) return [];
    return [{
      title: item.title,
      impact: item.impact,
      time: item.date,
      actual: String(item.actual ?? item.Actual ?? "").trim(),
      forecast: String(item.forecast ?? item.Forecast ?? "").trim(),
      previous: String(item.previous ?? item.prev ?? item.Previous ?? "").trim(),
      timestamp,
      day: dayKey(new Date(timestamp))
    }];
  });
  const select = events => {
    const unique = new Map();
    events.forEach(item => {
      const key = String(item.title).trim().toLowerCase() + "|" + item.timestamp;
      if (!unique.has(key)) unique.set(key, item);
    });
    const sorted = [...unique.values()].sort((a, b) =>
      a.timestamp - b.timestamp || IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact]
    );
    const upcoming = sorted.filter(item => item.timestamp >= Date.now());
    return (upcoming.length ? upcoming.slice(0, 6) : sorted.slice(-3).reverse())
      .map(({ timestamp, ...item }) => item);
  };

  const errors = [];
  let events = [];
  try {
    events = normalize(await fetchCalendar(thisWeekUrl));
  } catch (error) {
    errors.push({ url: thisWeekUrl, error: String(error) });
  }

  // The next-week JSON endpoint is often a 404 and counts toward the source's
  // rate limit. Only request it when this week's feed has no upcoming USD releases
  // (typically late Saturday), rather than hitting both endpoints on every poll.
  if (!events.some(item => item.timestamp >= Date.now())) {
    try {
      events = events.concat(normalize(await fetchCalendar(nextWeekUrl)));
    } catch (error) {
      errors.push({ url: nextWeekUrl, error: String(error) });
    }
  }

  calendarDebug = { feedErrors: errors };
  if (!events.length) {
    // If upstream is temporarily rate-limited, preserve a recent successful result.
    if (newsCache.value) return newsCache.value;
    throw new Error("ForexFactory calendar feeds unavailable");
  }

  const selected = select(events);
  if (!selected.length) {
    if (newsCache.value) return newsCache.value;
    throw new Error("No usable USD calendar events");
  }
  newsCache = { value: selected, expiresAt: Date.now() + 5 * 60 * 1000 };
  return selected;
}

module.exports = async function handler(req, res) {
  res.setHeader(   "Cache-Control",   "no-store, no-cache, must-revalidate, max-age=0" ); res.setHeader("Vercel-CDN-Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const quoteSpecs = [
    { pair: "XAU/USD", load: getGoldSpotQuote },
    ...SYMBOLS.map(([symbol, pair]) => ({ pair, load: () => getQuote(symbol, pair) }))
  ];
  const settledQuotes = await Promise.allSettled(quoteSpecs.map(spec => spec.load()));
  // Keep all five slots visible, including explicit unavailable states, rather than silently hiding failed quotes.
  const prices = settledQuotes.map((item, index) => {
    if (item.status === "fulfilled") return item.value;
    return {
      pair: quoteSpecs[index].pair,
      price: null,
      changePct: null,
      source: index === 0 ? "XAUS" : "Yahoo Finance",
      quoteAt: null,
      ageSeconds: null,
      marketState: null,
      freshness: "unavailable",
      isStale: false,
      error: String(item.reason?.message || item.reason || "Quote unavailable")
    };
  });
  let news = [];
  let newsUnavailable = false;
  try {
    news = await getNews();
  } catch (error) {
    newsUnavailable = true;
  }

  res.status(200).json({
    updatedAt: new Date().toISOString(),
    prices,
    news,
    partial: prices.some(item => item.freshness === "unavailable" || item.isStale) || newsUnavailable,
    ...(req.query?.debug === "1" ? { debug: calendarDebug } : {})
  });
};
