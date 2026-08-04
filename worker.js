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
// Revisit with real per-IP limiting if usage ever approaches this.
var DAILY_CALL_CAP = 200;

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
  arriveUtc: "HH:MM" 24h UTC/Zulu wall-clock arrival time, ONLY if they name
    an actual clock time or an unambiguous anchor like "midnight" (->
    "00:00") or "noon" (-> "12:00"). Do NOT set this for vague lighting
    preferences like "sunset" or "during the day" -- those are handled by
    separate scenic/daylight ranking, not a clock target.
  departInMin: integer minutes from now until wheels-up, only if a specific
    lead time is stated ("in an hour" -> 60, "in 30" -> 30).
  multileg: true if they describe a multi-stop/multi-leg trip/rotation,
    else omit.
  legs: integer 2-5, only if multileg is true and a count is implied (omit
    to default to 3 if multileg but no count given).
  mode: "list" only if they ask for options/choices/a few ideas, else omit
    (defaults to a single confident pick elsewhere).`;

function corsJson(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
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
  if (typeof parsed.arriveUtc === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(parsed.arriveUtc)) {
    out.arriveUtc = parsed.arriveUtc;
  }
  if (Number.isInteger(parsed.departInMin) && parsed.departInMin >= 0 && parsed.departInMin <= 1440) {
    out.departInMin = parsed.departInMin;
  }
  if (typeof parsed.multileg === "boolean") out.multileg = parsed.multileg;
  if (Number.isInteger(parsed.legs) && parsed.legs >= 2 && parsed.legs <= 5) out.legs = parsed.legs;
  if (parsed.mode === "list" || parsed.mode === "single") out.mode = parsed.mode;
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

  let groqResp;
  try {
    groqResp = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        max_tokens: 300,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt }
        ]
      })
    });
  } catch (e) {
    return corsJson({ error: "AI request failed" }, 502);
  }
  if (!groqResp.ok) {
    return corsJson({ error: `AI request failed (${groqResp.status})` }, 502);
  }

  let payload;
  try {
    payload = await groqResp.json();
    const raw = payload.choices[0].message.content;
    const parsed = JSON.parse(raw);
    return corsJson({ understood: sanitizeParsed(parsed) });
  } catch (e) {
    return corsJson({ error: "AI returned an unparseable response" }, 502);
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
