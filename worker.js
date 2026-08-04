// worker.js
var SECRET_KEY = "fsd-9x2Kp$vR#mQ7wL@nT4hZ";
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "X-FSD-Key, Content-Type"
};

// ── AI prompt-box parsing (new) ──────────────────────────────────────────
// Same job ai_client.py does for the private FlightRecommender app, hosted
// here instead so the public site's visitors don't need their own Groq key.
// The key itself lives only in this Worker's secret store (wrangler secret
// put GROQ_API_KEY), never in this file, never sent to a client.
var GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
var GROQ_MODEL = "llama-3.3-70b-versatile";
var MAX_PROMPT_LEN = 300;
// A coarse global daily cap, not per-visitor -- cheap (1 KV write/request,
// well under the free-tier write budget) and enough to stop the endpoint
// being drained as an open LLM relay unrelated to flight suggestions.
// Shared across /ai-parse and /ai-rank, and a single "Suggest" click now
// costs both (parse the prompt, then rank candidates) -- 400 keeps the
// same ~200 actual suggest-requests/day headroom as before this endpoint
// existed. Revisit with real per-IP limiting if usage ever approaches this.
var DAILY_CALL_CAP = 400;

// Exact aircraft-family tag vocabulary flightsim-dispatch.html's picker
// uses (see <select id="ac-family-picker"> in the HTML) -- the model must
// pick only from this list, never invent a tag.
var AC_FAMILY_TAGS = [
  "Aerospatiale/BAC Concorde", "Airbus A220", "Airbus A300", "Airbus A310",
  "CEO:Airbus A318", "CEO:Airbus A319", "NEO:Airbus A319",
  "CEO:Airbus A320", "NEO:Airbus A320", "CEO:Airbus A321", "NEO:Airbus A321",
  "CEO:Airbus A330", "NEO:Airbus A330", "Airbus A340", "Airbus A350", "Airbus A380",
  "Boeing 707", "Boeing 717", "Boeing 727", "737R:12", "737R:345", "737R:6789",
  "Boeing 737 MAX", "747C:Boeing 747", "747N:Boeing 747", "Boeing 757", "Boeing 767",
  "Boeing 777", "Boeing 787",
  "Douglas DC-8", "Douglas DC-9", "Douglas DC-10", "McDonnell Douglas MD-11",
  "McDonnell Douglas MD-8", "McDonnell Douglas MD-90",
  "Lockheed Constellation", "Lockheed Electra", "Lockheed L-1011",
  "BAC One-Eleven", "BAe 146", "Vickers VC",
  "Ilyushin Il-62", "Ilyushin Il-86", "Ilyushin Il-96", "Tupolev Tu-134", "Tupolev Tu-154",
  "ATR", "Bombardier CRJ", "Convair", "de Havilland Canada Dash 8",
  "Embraer ERJ", "Embraer E1", "Embraer E2", "Fokker"
];

var SYSTEM_PROMPT = `You translate a flight-sim pilot's plain-English request for what to
fly next into a JSON object of route-suggestion parameters. Only include a
key if the request clearly implies a value for it -- omit anything not
mentioned so sensible defaults apply elsewhere. Reply with ONLY a JSON
object, no prose, no markdown fences.

Keys you may set:
  dep: departure airport ICAO code (4 letters, uppercase), if named or
    clearly implied by a city name.
  acFamilies: an array using ONLY exact strings from this list (choose zero
    or more; broaden to multiple entries when the request is ambiguous
    about CEO/NEO or old/new, e.g. an unqualified "A321" -> both
    "CEO:Airbus A321" and "NEO:Airbus A321"):
    ${JSON.stringify(AC_FAMILY_TAGS)}
    Examples: "777"/"772"/"773" -> ["Boeing 777"]; "737"/"738"/"737ng" ->
    ["737R:6789"]; "737max"/"max8"/"max9" -> ["Boeing 737 MAX"];
    "747"/"742"/"747 classic" -> ["747C:Boeing 747"]; "747-400"/"747-8" ->
    ["747N:Boeing 747"]; "757" -> ["Boeing 757"]; "767" -> ["Boeing 767"].
  airline: 3-letter ICAO airline code, if named or clearly implied
    ("American"/"AA" -> "AAL", "British Airways" -> "BAW", etc.).
  arriveLocal: "HH:MM" 24h wall-clock arrival/deadline time, taken
    LITERALLY from whatever clock time or anchor word they said, in THE
    PILOT'S OWN LOCAL TIME -- this is the default for any bare time
    mention ("tonight 11pm" -> "23:00", "by 6pm" -> "18:00", "midnight" ->
    "00:00", "noon" -> "12:00", "9pm my time" -> "21:00"). Almost every
    casual mention of a time means their own local time, not Zulu -- use
    this field unless they explicitly say otherwise (see arriveUtc).
    IMPORTANT: just copy the HH:MM they said -- do NOT attempt to convert
    it to UTC or guess a timezone offset yourself; the app converts local
    to UTC using the visitor's own browser timezone, which you don't know
    and shouldn't guess at. Do NOT set this for vague lighting preferences
    like "sunset" or "during the day" -- those are handled by separate
    scenic/daylight ranking, not a clock target.
  arriveUtc: "HH:MM" 24h UTC/Zulu time, copied literally -- ONLY if they
    explicitly say "Zulu"/"UTC" or give a time with a "Z" suffix (e.g.
    "2300Z", "18:00 UTC"). Rare, technical aviation phrasing. If in doubt
    between this and arriveLocal, use arriveLocal.
  returnToOrigin: true if the request describes a there-and-back trip
    that ends up at the SAME airport it started from. Trigger words:
    "round trip", "day trip", "round-trip", "back at <the departure
    airport>", "back home", "return to <the departure airport>". Check
    for these words independently of whatever else you set -- don't let
    setting arriveLocal/dep distract you from also checking this.
  departInMin: integer minutes from now until wheels-up, only if a specific
    lead time is stated ("in an hour" -> 60, "in 30" -> 30).
  multileg: true if they describe a one-way multi-stop/connecting
    itinerary that does NOT return to the start, else omit. Do not set
    this together with returnToOrigin -- those are different trip shapes.
  legs: integer 2-5, only if multileg is true and a count is implied (omit
    to default to 3 if multileg but no count given).
  mode: "list" only if they ask for options/choices/a few ideas, else omit
    (defaults to a single confident pick elsewhere).
  historyMentioned: true ONLY if the request references the pilot's own
    past flying (e.g. "places I've never been", "somewhere I rarely fly",
    "haven't visited in a while", "different from my last flight"). This
    tool has no login and no flight history for anyone -- it cannot know
    what they have or haven't flown. Setting this lets the UI tell them
    that part of the request was ignored, instead of silently pretending
    to honor it. Do not try to guess or approximate their history -- just
    flag that they asked for it.`;

function corsJson(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
}

// Shared low-level Groq call -- both /ai-parse and /ai-rank use this.
// Throws Error("request") for network/HTTP failures, Error("parse") if the
// model's output isn't valid JSON -- callers map these to user-facing text.
async function callGroq(env, systemPrompt, userContent, maxTokens, temperature) {
  let resp;
  try {
    resp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: temperature != null ? temperature : 0,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ]
      })
    });
  } catch (e) {
    throw new Error("request");
  }
  if (!resp.ok) throw new Error("request");
  try {
    const payload = await resp.json();
    return JSON.parse(payload.choices[0].message.content);
  } catch (e) {
    throw new Error("parse");
  }
}

function sanitizeParsed(parsed) {
  const out = {};
  if (typeof parsed.dep === "string" && /^[A-Za-z]{4}$/.test(parsed.dep)) {
    out.dep = parsed.dep.toUpperCase();
  }
  if (Array.isArray(parsed.acFamilies)) {
    const fams = parsed.acFamilies.filter(f => AC_FAMILY_TAGS.includes(f));
    if (fams.length) out.acFamilies = fams;
  }
  if (typeof parsed.airline === "string" && /^[A-Za-z]{3}$/.test(parsed.airline)) {
    out.airline = parsed.airline.toUpperCase();
  }
  const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof parsed.arriveLocal === "string" && timeRe.test(parsed.arriveLocal)) {
    out.arriveLocal = parsed.arriveLocal;
  }
  if (typeof parsed.arriveUtc === "string" && timeRe.test(parsed.arriveUtc)) {
    out.arriveUtc = parsed.arriveUtc;
  }
  if (typeof parsed.returnToOrigin === "boolean") out.returnToOrigin = parsed.returnToOrigin;
  if (Number.isInteger(parsed.departInMin) && parsed.departInMin >= 0 && parsed.departInMin <= 1440) {
    out.departInMin = parsed.departInMin;
  }
  if (typeof parsed.multileg === "boolean") out.multileg = parsed.multileg;
  if (Number.isInteger(parsed.legs) && parsed.legs >= 2 && parsed.legs <= 5) out.legs = parsed.legs;
  if (parsed.mode === "list" || parsed.mode === "single") out.mode = parsed.mode;
  if (typeof parsed.historyMentioned === "boolean") out.historyMentioned = parsed.historyMentioned;
  return out;
}

async function withinDailyCap(env) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `ai_calls_${day}`;
  const current = parseInt(await env.FSD_DATA.get(key)) || 0;
  if (current >= DAILY_CALL_CAP) return false;
  await env.FSD_DATA.put(key, String(current + 1), { expirationTtl: 172800 });
  return true;
}

async function handleAiParse(request, env) {
  if (!env.GROQ_API_KEY) {
    return corsJson({ error: "AI parsing is not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return corsJson({ error: "invalid JSON body" }, 400);
  }
  const prompt = (body && body.prompt || "").trim();
  if (!prompt) return corsJson({ error: "prompt is required" }, 400);
  if (prompt.length > MAX_PROMPT_LEN) {
    return corsJson({ error: `prompt too long (max ${MAX_PROMPT_LEN} chars)` }, 400);
  }

  if (!(await withinDailyCap(env))) {
    return corsJson({ error: "AI parsing is temporarily at capacity for today -- try the manual filters" }, 429);
  }

  try {
    const parsed = await callGroq(env, SYSTEM_PROMPT, prompt, 300);
    return corsJson({ understood: sanitizeParsed(parsed) });
  } catch (e) {
    return corsJson({ error: e.message === "parse" ? "AI returned an unparseable response" : "AI request failed" }, 502);
  }
}

// ── AI scenic-destination reasoning (new) ────────────────────────────────
// Per explicit product decision: "scenic" is a subjective travel judgment,
// not something a fixed list should decide. This asks the model to reason
// about actual scenic quality (geography, coastlines, mountains, dramatic
// approaches, etc.) over the real candidate destinations reachable from the
// chosen departure -- it never invents a destination outside that list, and
// it never picks the route/aircraft/time itself (that stays deterministic
// client-side, since flight time and daylight quality are objective, not a
// preference call). Volanta's curated tags are passed only as a hint the
// model may use or ignore, not a filter.
var MAX_RANK_CANDIDATES = 150;

var RANK_SYSTEM_PROMPT = `A flight-sim pilot wants a scenic destination suggestion. You will be
given their request and a list of candidate airports that are actually
reachable (ICAO, city, country, and an optional curatedTier hint --
"premium"/"deluxe"/"standard" if a flight-sim scenery add-on curator rates
it, absent if not). Use your own knowledge of world geography -- coastlines,
mountains, islands, dramatic approaches, iconic skylines -- to judge which
candidates are genuinely scenic and best match what they asked for. The
curatedTier hint is a data point, not a rule; you may pick a candidate
without one, or skip one that has one, if your own geographic judgment says
otherwise. Only choose ICAOs that appear in the candidate list -- never
invent one. If few or none of the candidates are meaningfully scenic, return
fewer picks than asked rather than padding with weak choices.

Reply with ONLY JSON: {"picks":[{"icao":"KXXX","reason":"one short sentence
grounded in actual geography, not generic phrases like \\"has scenery\\""}]}`;

function sanitizeRankPicks(parsed, validIcaos) {
  if (!Array.isArray(parsed.picks)) return [];
  const seen = new Set();
  const out = [];
  for (const p of parsed.picks) {
    if (!p || typeof p.icao !== "string") continue;
    const icao = p.icao.toUpperCase();
    if (!validIcaos.has(icao) || seen.has(icao)) continue;
    seen.add(icao);
    out.push({ icao, reason: typeof p.reason === "string" ? p.reason.slice(0, 200) : "" });
  }
  return out;
}

async function handleAiRank(request, env) {
  if (!env.GROQ_API_KEY) {
    return corsJson({ error: "AI ranking is not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return corsJson({ error: "invalid JSON body" }, 400);
  }
  const prompt = (body && body.prompt || "").trim();
  const candidates = Array.isArray(body && body.candidates) ? body.candidates.slice(0, MAX_RANK_CANDIDATES) : [];
  const count = Math.min(Math.max(parseInt(body && body.count) || 1, 1), 5);
  if (!candidates.length) return corsJson({ error: "candidates is required" }, 400);
  if (prompt.length > MAX_PROMPT_LEN) {
    return corsJson({ error: `prompt too long (max ${MAX_PROMPT_LEN} chars)` }, 400);
  }

  if (!(await withinDailyCap(env))) {
    return corsJson({ error: "AI ranking is temporarily at capacity for today" }, 429);
  }

  const validIcaos = new Set(candidates.map(c => String(c.icao || "").toUpperCase()));
  const userContent = JSON.stringify({
    request: prompt || "something scenic",
    wantCount: count,
    candidates: candidates.map(c => ({
      icao: c.icao, city: c.city, country: c.country,
      ...(c.curatedTier ? { curatedTier: c.curatedTier } : {})
    })),
  });

  try {
    const parsed = await callGroq(env, RANK_SYSTEM_PROMPT, userContent, 800, 0.3);
    return corsJson({ picks: sanitizeRankPicks(parsed, validIcaos) });
  } catch (e) {
    return corsJson({ error: e.message === "parse" ? "AI returned an unparseable response" : "AI request failed" }, 502);
  }
}
// ──────────────────────────────────────────────────────────────────────

var worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const key = request.headers.get("X-FSD-Key");
    if (key !== SECRET_KEY) {
      return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
    }
    const { pathname } = new URL(request.url);

    if (pathname === "/ai-parse") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
      }
      return handleAiParse(request, env);
    }

    if (pathname === "/ai-rank") {
      if (request.method !== "POST") {
        return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
      }
      return handleAiRank(request, env);
    }

    if (pathname === "/meta" || pathname === "/routes") {
      const kvKey = pathname === "/meta" ? "meta_gz" : "routes_gz";
      const bytes = await env.FSD_DATA.get(kvKey, { type: "arrayBuffer" });
      if (!bytes) {
        return new Response(`${kvKey} not found in KV`, { status: 404, headers: CORS_HEADERS });
      }
      return new Response(bytes, {
        headers: {
          ...CORS_HEADERS,
          "Content-Type": "application/octet-stream",
          "Cache-Control": "public, max-age=3600"
        }
      });
    }
    const data = await env.FSD_DATA.get("data");
    if (!data) {
      return new Response("Data not found in KV", { status: 404, headers: CORS_HEADERS });
    }
    return new Response(data, {
      headers: { ...CORS_HEADERS, "Content-Type": "application/javascript" }
    });
  }
};
export {
  worker_default as default
};
