// worker.js
var SECRET_KEY = "fsd-9x2Kp$vR#mQ7wL@nT4hZ";
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "X-FSD-Key, Content-Type"
};

// ── AI prompt-box parsing (new) ──────────────────────────────────────────
// Same job ai_client.py does for the private FlightRecommender app, hosted
// here instead so the public site's visitors don't need their own key.
// Keys live only in this Worker's secret store (wrangler secret put
// GEMINI_API_KEY / GROQ_API_KEY), never in this file, never sent to a client.
//
// Two independent providers now, both speaking the same OpenAI-compatible
// /chat/completions shape (Google's own compat endpoint for Gemini, native
// for Groq) -- callLLM below tries them in order as one flat list, so an
// outage or rate limit on one provider falls through to the other, not
// just to another model on the SAME provider.
//
// Groq is primary despite Gemini 3.x being the stronger model: measured
// directly, Gemini 3.7/3.5 Flash currently take 17-35+ seconds per call
// (3.7 also frequently 503s -- "experiencing high demand", consistent
// with these being brand-new models still ramping serving capacity) vs
// Groq's 1-3 seconds -- speed is Groq's whole hardware differentiator.
// For a chat feature, a 20-60+ second combined parse+rank wait per
// message isn't worth Gemini's extra reasoning quality on every turn, so
// Gemini is kept configured purely as a fallback tier: normal traffic
// never touches it, but if Groq's models are ever down or rate-limited
// the request still completes (slowly) instead of failing outright.
var GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
var GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
// Groq's free-tier token-per-day quota is tracked PER MODEL, not
// account-wide (confirmed via a real 429: "Rate limit reached for model
// llama-3.3-70b-versatile ... tokens per day (TPD): Limit 100000"). Heavy
// testing exhausted that model's whole daily budget for one day.
// Tried splitting /ai-parse onto llama-3.1-8b-instant to isolate it from
// /ai-rank's heavier daily quota use -- reverted: reproducibly worse at
// this exact task (e.g. consistently hallucinated mode:"list" on "flying
// from KDFW, something scenic", a plain single-destination request with
// no list/options language at all; llama-3.3-70b-versatile got it right
// every time, verified directly against the same prompt).
//
// llama-3.3-70b-versatile itself was retired for free/developer-tier Groq
// accounts on 2026-08-16 (still fine for enterprise committed-spend
// accounts, which this isn't) -- calls started failing with HTTP 404
// "model_not_found". Groq's own migration guidance pointed free-tier users
// at openai/gpt-oss-120b/-20b as replacements, which is what's still here
// as the fallback tier below Gemini.
//
// callLLM skips any entry whose env var isn't set (so this still degrades
// to Groq-only if GEMINI_API_KEY is ever removed, rather than breaking).
function llmProviders(models) {
  return [
    { baseUrl: GROQ_URL, apiKeyEnv: "GROQ_API_KEY", model: models[0] },
    { baseUrl: GROQ_URL, apiKeyEnv: "GROQ_API_KEY", model: models[1] },
    { baseUrl: GEMINI_URL, apiKeyEnv: "GEMINI_API_KEY", model: "gemini-3.7-flash" },
    { baseUrl: GEMINI_URL, apiKeyEnv: "GEMINI_API_KEY", model: "gemini-3.5-flash" },
  ];
}
var PARSE_PROVIDERS = llmProviders(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
var RANK_PROVIDERS = llmProviders(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
// Caps on the conversation history the client can send -- both a real cost
// control (each turn re-sends the whole history, so an unbounded thread
// gets expensive fast) and abuse control (this endpoint has no auth beyond
// the shared site key, so it's the only thing stopping a huge fabricated
// "history" array from being used as a free-form prompt-stuffing relay).
var MAX_HISTORY_TURNS = 24;
var MAX_TURN_LEN = 400;

// Keeps only well-formed {role, content} turns, in order, trimmed to the
// most recent MAX_HISTORY_TURNS -- used by both /ai-parse and /ai-rank
// since both now take real conversation history instead of one prompt.
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_HISTORY_TURNS)
    .map(m => ({ role: m.role, content: m.content.trim().slice(0, MAX_TURN_LEN) }));
}
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
  "Boeing 737 MAX", "747C:Boeing 747", "747N:Boeing 747",
  "747:100", "747:200", "747:300", "747:SP", "Boeing 757", "Boeing 767",
  "Boeing 777", "Boeing 787",
  "Douglas DC-8", "Douglas DC-9", "Douglas DC-10", "McDonnell Douglas MD-11",
  "McDonnell Douglas MD-8", "McDonnell Douglas MD-90",
  "Lockheed Constellation", "Lockheed Electra", "Lockheed L-1011",
  "BAC One-Eleven", "BAe 146", "Vickers VC",
  "Ilyushin Il-62", "Ilyushin Il-86", "Ilyushin Il-96", "Tupolev Tu-134", "Tupolev Tu-154",
  "ATR", "Bombardier CRJ", "Convair", "de Havilland Canada Dash 8",
  "Embraer ERJ", "Embraer E1", "Embraer E2", "Fokker"
];

var SYSTEM_PROMPT = `You are the understanding layer for a flight-sim route-planning chatbot.
You will be given the full back-and-forth conversation so far (a pilot's
messages, and your own past replies), not just one isolated message.
Your job each turn is to output ONE JSON object describing the CURRENT
best understanding of what they want, resolved across the WHOLE
conversation -- something said two turns ago (a departure airport, an
aircraft) still applies unless a later message clearly changes it. A
later message that refines or contradicts an earlier one (e.g. "actually
somewhere warmer instead") should win for whatever it touches, leaving
everything else from earlier turns untouched.

Only include a key if the conversation CLEARLY AND EXPLICITLY implies a
value for it -- when in doubt, omit the key rather than guess. Do not
infer a time, a mode, or anything else just because a message happens to
mention travel -- every key below needs its own real textual evidence
somewhere in the conversation. Reply with ONLY a JSON object, no prose, no
markdown fences.

Two keys control the flow before anything else:
  needsClarification: true ONLY if a departure airport still cannot be
    determined from the ENTIRE conversation -- that is the one piece of
    information nothing else here can work without. Every other key is
    optional and fine to leave unset. When true, set clarifyingQuestion
    and omit every key below except dep (still include it if you managed
    to resolve one despite something else being unclear -- that shouldn't
    happen often, since dep is the only trigger for this).
  clarifyingQuestion: a short, natural, conversational question to ask
    back -- ONLY set when needsClarification is true. e.g. "Which airport
    are you flying out of?" Not a form-field label, an actual question a
    person would type in a chat.

If needsClarification is not set (i.e. a departure is known), also set
whichever of these apply:
  dep: departure airport ICAO code (4 letters, uppercase), if named or
    clearly implied by a city name.
  acFamilies: an array using ONLY exact strings from this list (choose zero
    or more; broaden to multiple entries when the request is ambiguous
    about CEO/NEO or old/new, e.g. an unqualified "A321" -> both
    "CEO:Airbus A321" and "NEO:Airbus A321"):
    ${JSON.stringify(AC_FAMILY_TAGS)}
    Examples: "777"/"772"/"773" -> ["Boeing 777"]; "737"/"738"/"737ng" ->
    ["737R:6789"]; "737max"/"max8"/"max9" -> ["Boeing 737 MAX"];
    "747"/"747 classic"/"jumbo" (no specific series number given) ->
    ["747C:Boeing 747"] (broad -- every classic-era 747: -100/-200/-300/SP);
    "747-400"/"747-8" -> ["747N:Boeing 747"]; "757" -> ["Boeing 757"];
    "767" -> ["Boeing 767"]. When a 747 request DOES name specific series
    numbers, use the narrow "747:100"/"747:200"/"747:300"/"747:SP" tags
    instead of the broad 747C one, choosing only the ones actually named --
    "747-100 or 200"/"747-100/200" -> ["747:100","747:200"] (NOT 747C,
    which would also match -300 and SP that weren't asked for); "747SP" on
    its own -> ["747:SP"]; "742" ALONE with no other qualifier is loose
    informal shorthand for "an old-school 747" in general, not the strict
    ICAO type-designator meaning of specifically -200 -- keep treating a
    bare "742" as broad 747C, same as unqualified "747".
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
    RELATIVE lead time is stated ("in an hour" -> 60, "in 30" -> 30). Do NOT
    use this for an absolute clock time ("wheels up at 5pm") -- that's
    departLocal/departUtc below; if both this and one of those would
    otherwise apply, set only departLocal/departUtc.
  departLocal: "HH:MM" 24h wall-clock WHEELS-UP time, taken LITERALLY from
    whatever clock time they said, in THE PILOT'S OWN LOCAL TIME -- exact
    same rule as arriveLocal above, just for departure instead of arrival
    ("wheels up at 5pm" -> "17:00", "depart at 4pm central" -> "16:00",
    "leaving around 9am" -> "09:00"). Same IMPORTANT note as arriveLocal:
    just copy the HH:MM, do not convert timezones yourself.
  departUtc: "HH:MM" 24h UTC/Zulu wheels-up time -- same rare-case mirror
    of departLocal that arriveUtc is of arriveLocal.
  maxTotalMin: integer minutes -- a cap on TOTAL flight/block time for the
    whole trip (sum of each leg's actual flight time, NOT counting
    ground/layover time between legs -- that's how pilots mean "block
    time"), only if they state a duration or time budget for the whole
    trip ("under 9 hours", "no more than 6 hours of flying", "keep it
    under a day of flying"). Convert stated hours to minutes ("9 hours" ->
    540). Do NOT set this from a single clock-time deadline (that's
    arriveLocal/arriveUtc) or an aircraft-range remark -- only an actual
    total-duration/budget statement.
  minTotalMin: integer minutes -- a floor on that same TOTAL flight/block
    time, only if they state one ("at least 3 hours", "minimum 2 hours of
    flying"). A stated RANGE ("between 3 and 5 hours", "3 to 5 hours of
    flying") sets BOTH minTotalMin and maxTotalMin from the two ends.
  multileg: true if they describe a one-way multi-stop/connecting
    itinerary that does NOT return to the start, else omit. Do not set
    this together with returnToOrigin -- those are different trip shapes.
  legs: integer 2-5, only if multileg is true and a count is implied (omit
    to default to 3 if multileg but no count given).
  finalArr: departure airport ICAO code (4 letters, uppercase) that a
    multileg trip must specifically END at, ONLY if one is explicitly
    named ("4 leg trip ending at LAX" -> "KLAX", "...finishing in Tokyo"
    -> the city's ICAO). Only set alongside multileg:true, never with
    returnToOrigin (a round trip's destination is the intermediate scenic
    stop, chosen by a separate step, not something to force here). Do NOT
    set this for a vague "ending somewhere warm" style request -- that's
    the vibe field's job; this is ONLY for a specific named airport/city.
  finalRegion: a country or broad geographic region, written as a real
    recognizable English place name (e.g. "United States", "Europe",
    "Japan", "South America", "Southeast Asia"), ONLY if the pilot states
    a country/region (not one specific airport/city -- that's finalArr,
    and not a vague vibe like "somewhere warm" -- that's the vibe field)
    that a multileg trip must END in ("ends back in the US" -> "United
    States", "finishing somewhere in Europe" -> "Europe", "ends up back
    in Japan" -> "Japan"). A later step matches this against each
    candidate's real country using its own geographic knowledge, not
    exact string comparison, so write it as you'd naturally say it, not a
    code. Only ever set alongside multileg:true, never with
    returnToOrigin. If the pilot names one specific airport/city instead,
    set finalArr and omit this.
  mode: "list" if they ask for options/choices/a few ideas/picks in ANY
    form, including a specific count ("give me 3 options", "show me some
    choices", "a couple ideas", "list a few picks") -- a stated number of
    options is itself list language, not just the word "options" alone.
    Else omit (defaults to a single confident pick elsewhere).
  wantCount: integer 1-5, only if they state a specific number of options
    ("3 options" -> 3, "5 picks" -> 5, "a couple" -> 2, "a few" -> 3, "a
    handful" -> 4). Always set mode:"list" alongside this -- a specific
    count IS a request for a list, even without the word "options"/"list"
    appearing separately.
  historyMentioned: true ONLY if the request references the pilot's own
    past flying (e.g. "places I've never been", "somewhere I rarely fly",
    "haven't visited in a while", "different from my last flight"). This
    tool has no login and no flight history for anyone -- it cannot know
    what they have or haven't flown. Setting this lets the UI tell them
    that part of the request was ignored, instead of silently pretending
    to honor it. Do not try to guess or approximate their history -- just
    flag that they asked for it.
  vibe: an array of short, concrete geographic/character descriptors
    capturing what kind of place they actually want -- this is what a
    later step uses to judge candidate destinations, so make it specific
    and real, not a restatement of generic words like "scenic" or "nice"
    on their own. Pull the real content out of whatever language they
    used: "mountainous"/"somewhere with mountains" -> ["mountainous"];
    "arctic"/"somewhere cold and remote" -> ["arctic","remote"];
    "tropical island" -> ["tropical","island"]; "desert" -> ["desert"];
    "fjords"/"norway-like" -> ["fjords"]; "somewhere with a dramatic
    approach" -> ["dramatic approach"]; "avoid big cities"/"nothing
    touristy" -> ["avoid major hub cities"]; "somewhere I could actually
    see mountains landing" -> ["mountainous","dramatic approach"]. A bare
    "something scenic" with no further description is NOT enough to set
    this -- leave it unset and let the next step use its own general
    judgment. If a later message refines an earlier vibe (see the
    conversation-resolution rule above), the array should reflect the
    CURRENT intent, not every vibe word ever mentioned -- "actually
    somewhere warmer" after "mountainous" means drop "mountainous" if it
    was cold-mountain framing, or keep it if warm mountains still fit
    (e.g. tropical volcanic islands) -- use real judgment, not literal
    accumulation.`;

function corsJson(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
}

// Shared low-level LLM call -- both /ai-parse and /ai-rank use this.
// `providers` (see llmProviders above) is a flat, ordered list spanning
// BOTH providers -- e.g. [gemini-3.7, gemini-3.5, groq-120b, groq-20b] --
// tried in sequence, advancing to the next entry on: 429 (rate/quota),
// 404 (model retired -- happened for real, see the deprecation note
// above), 401/403 (bad/missing key for THAT provider specifically -- since
// providers now have independent keys, this no longer means every entry
// will fail the same way like it did when everything shared one Groq key),
// 500/502/503 (upstream having a bad moment -- observed in practice from
// Gemini as "This model is currently experiencing high demand"), or a
// 400 specifically carrying "json_validate_failed" (seen in practice as an
// empty completion from a smaller model, not a problem with what we sent).
// Any OTHER failure (a genuinely malformed request on our end) fails
// immediately rather than masking a real bug behind silent fallbacks.
// Throws Error("request:<detail>") for failures (detail is the upstream
// status/body so failures are actually diagnosable), Error("parse") if
// no provider's output was valid JSON.
//
// `messages` is the REAL conversation so far (role:"user"/"assistant"
// turns, oldest first) -- not a single flattened string. Passing actual
// multi-turn history is what lets the model resolve "no, somewhere colder"
// or "not that one" against what was actually said earlier, the same way
// any chat model handles a follow-up. response_format:json_object only
// constrains the CURRENT completion, so prior assistant turns being plain
// conversational text (not JSON) is fine.
async function callLLM(env, providers, systemPrompt, messages, maxTokens, temperature) {
  let lastErr = null;
  for (const p of providers) {
    // .trim() defends against a stray trailing newline from however the
    // secret was set (e.g. `wrangler secret put` via a piped shell value) --
    // a mangled key produces a genuinely confusing "invalid API key" error
    // that has nothing to do with the key itself being wrong.
    const apiKey = (env[p.apiKeyEnv] || "").trim();
    if (!apiKey) continue; // that provider's key isn't configured here -- skip it, not an error
    let resp;
    try {
      resp = await fetch(p.baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: p.model,
          temperature: temperature != null ? temperature : 0,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            ...messages
          ]
        })
      });
    } catch (e) {
      // A network hiccup reaching ONE provider shouldn't sink the whole
      // request when another, independent provider might still be up.
      lastErr = new Error(`request:network error contacting ${p.model}`);
      continue;
    }
    if (!resp.ok) {
      let bodyText = "";
      try { bodyText = (await resp.text()).slice(0, 300); } catch {}
      if (resp.status === 429 || resp.status === 404 || resp.status === 401 || resp.status === 403 ||
          resp.status === 500 || resp.status === 502 || resp.status === 503 ||
          (resp.status === 400 && bodyText.includes("json_validate_failed"))) {
        lastErr = new Error(`request:HTTP ${resp.status} (${p.model}) ${bodyText}`);
        continue;
      }
      throw new Error(`request:HTTP ${resp.status} ${bodyText}`);
    }
    try {
      const payload = await resp.json();
      return JSON.parse(payload.choices[0].message.content);
    } catch (e) {
      throw new Error("parse");
    }
  }
  throw lastErr || new Error("request:no provider configured or all at capacity");
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
  // departLocal/departUtc (an absolute clock time) take priority over
  // departInMin (a relative lead time) when somehow both are present --
  // the former has a real client-side conversion path (resolveDepartUtc),
  // the latter is just the AI's own unverifiable estimate.
  if (typeof parsed.departLocal === "string" && timeRe.test(parsed.departLocal)) {
    out.departLocal = parsed.departLocal;
  } else if (typeof parsed.departUtc === "string" && timeRe.test(parsed.departUtc)) {
    out.departUtc = parsed.departUtc;
  } else if (Number.isInteger(parsed.departInMin) && parsed.departInMin >= 0 && parsed.departInMin <= 1440) {
    out.departInMin = parsed.departInMin;
  }
  if (Number.isInteger(parsed.wantCount) && parsed.wantCount >= 1 && parsed.wantCount <= 5) {
    out.wantCount = parsed.wantCount;
  }
  if (Number.isInteger(parsed.maxTotalMin) && parsed.maxTotalMin >= 30 && parsed.maxTotalMin <= 4320) {
    out.maxTotalMin = parsed.maxTotalMin;
  }
  if (Number.isInteger(parsed.minTotalMin) && parsed.minTotalMin >= 30 && parsed.minTotalMin <= 4320) {
    out.minTotalMin = parsed.minTotalMin;
  }
  // A nonsensical inverted range (min > max) shouldn't silently make
  // every candidate impossible -- the max cap is the safety constraint
  // (never exceed a stated budget), so keep it and drop the floor.
  if (out.minTotalMin != null && out.maxTotalMin != null && out.minTotalMin > out.maxTotalMin) {
    delete out.minTotalMin;
  }
  if (typeof parsed.multileg === "boolean") out.multileg = parsed.multileg;
  if (Number.isInteger(parsed.legs) && parsed.legs >= 2 && parsed.legs <= 5) out.legs = parsed.legs;
  if (typeof parsed.finalArr === "string" && /^[A-Za-z]{4}$/.test(parsed.finalArr)) {
    out.finalArr = parsed.finalArr.toUpperCase();
  }
  if (typeof parsed.finalRegion === "string" && parsed.finalRegion.trim()) {
    out.finalRegion = parsed.finalRegion.trim().slice(0, 60);
  }
  if (parsed.mode === "list" || parsed.mode === "single") out.mode = parsed.mode;
  // wantCount is a stronger signal than mode -- an explicit "3 options"
  // means list mode even if the model separately (contradictorily) said
  // mode:"single" for the same turn.
  if (out.wantCount) out.mode = "list";
  if (typeof parsed.historyMentioned === "boolean") out.historyMentioned = parsed.historyMentioned;
  if (Array.isArray(parsed.vibe)) {
    const vibe = parsed.vibe.filter(v => typeof v === "string" && v.trim()).map(v => v.trim().slice(0, 40)).slice(0, 6);
    if (vibe.length) out.vibe = vibe;
  }
  // needsClarification short-circuits the whole rest of the pipeline
  // client-side (no DB search, no /ai-rank call) -- only dep is kept
  // alongside it, everything else is dropped since the model was told not
  // to set them in that case anyway; this just enforces it server-side too.
  if (parsed.needsClarification === true && typeof parsed.clarifyingQuestion === "string" && parsed.clarifyingQuestion.trim()) {
    return { needsClarification: true, clarifyingQuestion: parsed.clarifyingQuestion.trim().slice(0, 300), ...(out.dep ? { dep: out.dep } : {}) };
  }
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
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) {
    return corsJson({ error: "AI parsing is not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return corsJson({ error: "invalid JSON body" }, 400);
  }
  const history = sanitizeHistory(body && body.history);
  if (!history.length || history[history.length - 1].role !== "user") {
    return corsJson({ error: "history must be a non-empty conversation ending in a user message" }, 400);
  }

  if (!(await withinDailyCap(env))) {
    return corsJson({ error: "AI parsing is temporarily at capacity for today -- try the manual filters" }, 429);
  }

  try {
    // Generous, not tight -- several fallback tiers here (gpt-oss-20b, and
    // now Gemini 3.x too) are reasoning models that burn tokens on
    // invisible chain-of-thought before the visible JSON (confirmed
    // directly against Gemini: a 6-token visible reply still cost ~100
    // thinking tokens). Too tight a cap starves that mid-thought and it
    // returns nothing (a real failure seen in testing, not hypothetical).
    // Raising the ceiling costs nothing on the free tier either way.
    const parsed = await callLLM(env, PARSE_PROVIDERS, SYSTEM_PROMPT, history, 3000);
    return corsJson({ understood: sanitizeParsed(parsed) });
  } catch (e) {
    return corsJson({ error: e.message === "parse" ? "AI returned an unparseable response" : ("AI request failed -- " + e.message.replace(/^request:/, "")) }, 502);
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
// Cut from 150 -- this is the dominant cost of an /ai-rank call (roughly
// 15-20 tokens/candidate x 150 ~= 2500+ tokens, versus ~300 for the fixed
// system prompt), and it's the actual lever for handling several visitors
// hitting Suggest in the same minute: Groq's TPM cap (not the daily one)
// is what a real simultaneous-user burst would hit first, and every
// candidate cut buys more concurrent requests that fit in that window.
// Curated-tier candidates are still sorted first (see destCandidatesFor),
// so this trims long-tail obscure destinations before it ever touches the
// ones actually likely to be picked.
var MAX_RANK_CANDIDATES = 60;

var RANK_SYSTEM_PROMPT = `You are the destination-picking half of a flight-sim route-planning
chatbot. You'll see the real conversation so far (a pilot's messages, and
your own past replies -- use it: reference it naturally, and if their
latest message rejects or refines a previous pick, respond to THAT, don't
just restate the same kind of thing), followed by one final message
containing the actual candidate airports that are reachable given
everything already resolved (departure, aircraft, timing) -- ICAO, full
name, city, country, an optional curatedTier, and an optional connections
count. Only choose ICAOs from that candidate list -- never invent one.

GEOGRAPHIC JUDGMENT IS THE WHOLE JOB. Use your own real knowledge of world
geography -- actual mountain ranges, coastlines, fjords, deserts, islands,
canyons, glaciers, dramatic approaches -- to judge which candidates
actually match what's being asked, not just which ones are famous. The
full airport name disambiguates same-named cities (e.g. bare "Jackson" is
ambiguous between Jackson, Mississippi and Jackson Hole, Wyoming near the
Tetons -- use the airport name, don't guess from the city name alone).

If the conversation gives you specific character to match (mountainous,
arctic, tropical, desert, remote, fjords, etc.), that IS the bar -- a
candidate only counts as a good pick if it genuinely has that real-world
character, not just because it's on the list or well-known. If nothing
specific was asked beyond generic "scenic", fall back to your own judgment
of genuinely striking natural or dramatic geography.

AVOID GENERIC MAJOR HUBS. Airports like JFK, LAX, ORD, ATL, DFW, IAH, CDG,
FRA, AMS exist on candidate lists constantly because they're huge and
well-connected, not because they're worth a special trip to look at from
the air -- sprawling flat urban development on approach, nothing distinct
about the geography itself. Don't pick one just because it's there or
familiar. A high "connections" number on a candidate is a same signal --
treat a very large connections count as "generic major hub, not
inherently interesting" unless the actual real-world geography there is
genuinely exceptional (a big airport CAN still be a great pick if the
terrain/approach really is dramatic -- e.g. a coastal or mountain-ringed
big city is fine -- the point is size/fame alone is never the reason,
real geography is). Likewise curatedTier ("premium"/"deluxe"/"standard")
means a flight-sim scenery add-on exists for it -- that's usually BECAUSE
it's a popular real-world hub, so it is not a scenic-quality signal
either; use it only as a tie-breaker between two candidates you already
judged equally good on geography, never as a reason to pick something on
its own.

If few or none of the candidates genuinely fit, return fewer picks than
asked (even zero) rather than padding with weak choices -- say so plainly
in "reply" instead.

finalRegion, when present, is a HARD requirement, not a preference: the
pilot said this multileg trip must end in that country/region. Before any
scenic judgment, drop every candidate whose "country" field is not
genuinely within that region (use your own real geography -- e.g.
finalRegion "United States" excludes anything not one of the 50 states;
finalRegion "Europe" excludes anything outside Europe). Only THEN apply
the usual scenic/geographic reasoning to what's left. If literally nothing
in the candidate list is actually in that region, say so plainly in
"reply" and return zero picks -- never pick a candidate outside the
stated region just because it's scenic or nothing else qualifies.

wantCount is how many entries to put in "picks" -- but that's often
larger than what the pilot will actually see: the app always asks for
several as internal fallbacks (in case its top choice's schedule lands at
night, it tries the next one down), not necessarily because the pilot
wants a list of options. Only write "reply" as introducing multiple
options ("here are a few picks...") when showAsOptions is true. When it's
false (the common case), write "reply" as recommending ONE specific
place, confidently, even though you're still asked to return several
picks in the array -- never say "here are five" or similar when
showAsOptions is false.

Reply with ONLY JSON:
{"reply":"one or two natural, conversational sentences introducing the
pick(s) -- write like you're actually replying in the chat, not
captioning a card. Reference the conversation if relevant (e.g.
acknowledging a refinement).",
"picks":[{"icao":"KXXX","reason":"one short sentence grounded in actual
geography, not generic phrases like \\"has scenery\\""}]}`;

function sanitizeRankPicks(parsed, validIcaos) {
  const picks = [];
  if (Array.isArray(parsed.picks)) {
    const seen = new Set();
    for (const p of parsed.picks) {
      if (!p || typeof p.icao !== "string") continue;
      const icao = p.icao.toUpperCase();
      if (!validIcaos.has(icao) || seen.has(icao)) continue;
      seen.add(icao);
      picks.push({ icao, reason: typeof p.reason === "string" ? p.reason.slice(0, 200) : "" });
    }
  }
  const reply = typeof parsed.reply === "string" ? parsed.reply.trim().slice(0, 500) : "";
  return { reply, picks };
}

async function handleAiRank(request, env) {
  if (!env.GEMINI_API_KEY && !env.GROQ_API_KEY) {
    return corsJson({ error: "AI ranking is not configured" }, 503);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return corsJson({ error: "invalid JSON body" }, 400);
  }
  const history = sanitizeHistory(body && body.history);
  const candidates = Array.isArray(body && body.candidates) ? body.candidates.slice(0, MAX_RANK_CANDIDATES) : [];
  const count = Math.min(Math.max(parseInt(body && body.count) || 1, 1), 5);
  // Whether the pilot actually asked for multiple options to choose from
  // (vs the client always requesting up to `count` candidates internally,
  // even for a single-destination request, purely as fallbacks in case the
  // top pick's schedule lands at night -- see buildChain's comment). Without
  // this the model had no way to know a "wantCount:5" request was really
  // "give me several to pick from as backups", not "the pilot wants five
  // options" -- it would write a reply like "here are five..." even when
  // the app was only ever going to show the single best-timed one.
  const showAsOptions = !!(body && body.showAsOptions);
  // A country/region a multileg trip's final leg must land in ("ends back
  // in the US") -- see finalRegion in the parse SYSTEM_PROMPT. Free text,
  // matched against each candidate's own country field by the model's real
  // geographic knowledge (see RANK_SYSTEM_PROMPT), not string-compared here.
  const finalRegion = typeof (body && body.finalRegion) === "string" ? body.finalRegion.trim().slice(0, 60) : "";
  if (!candidates.length) return corsJson({ error: "candidates is required" }, 400);
  if (!history.length || history[history.length - 1].role !== "user") {
    return corsJson({ error: "history must be a non-empty conversation ending in a user message" }, 400);
  }

  if (!(await withinDailyCap(env))) {
    return corsJson({ error: "AI ranking is temporarily at capacity for today" }, 429);
  }

  const validIcaos = new Set(candidates.map(c => String(c.icao || "").toUpperCase()));
  // Tacked on as one final user turn AFTER the real conversation -- the
  // model reasons over the actual back-and-forth for tone/context/vibe,
  // then gets the literal reachable-candidate data to choose from here.
  const candidateMsg = JSON.stringify({
    wantCount: count,
    showAsOptions,
    ...(finalRegion ? { finalRegion } : {}),
    candidates: candidates.map(c => ({
      icao: c.icao, name: c.name, city: c.city, country: c.country,
      ...(c.curatedTier ? { curatedTier: c.curatedTier } : {}),
      ...(Number.isInteger(c.connections) ? { connections: c.connections } : {})
    })),
  });

  try {
    const messages = [...history, { role: "user", content: candidateMsg }];
    const parsed = await callLLM(env, RANK_PROVIDERS, RANK_SYSTEM_PROMPT, messages, 3000, 0.3);
    return corsJson(sanitizeRankPicks(parsed, validIcaos));
  } catch (e) {
    return corsJson({ error: e.message === "parse" ? "AI returned an unparseable response" : ("AI request failed -- " + e.message.replace(/^request:/, "")) }, 502);
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
