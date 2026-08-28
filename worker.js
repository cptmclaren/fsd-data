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
// Groq's free-tier token-per-day quota is tracked PER MODEL, not
// account-wide (confirmed via a real 429: "Rate limit reached for model
// llama-3.3-70b-versatile ... tokens per day (TPD): Limit 100000"). Heavy
// testing exhausted that model's whole daily budget for one day.
// Tried splitting /ai-parse onto llama-3.1-8b-instant to isolate it from
// /ai-rank's heavier daily quota use -- reverted: reproducibly worse at
// this exact task (e.g. consistently hallucinated mode:"list" on "flying
// from KDFW, something scenic", a plain single-destination request with
// no list/options language at all; llama-3.3-70b-versatile got it right
// every time, verified directly against the same prompt). Both endpoints
// share the same primary/fallback pair so a quota exhaustion or model
// retirement degrades the whole pipeline together, not just half of it.
//
// llama-3.3-70b-versatile itself was retired for free/developer-tier Groq
// accounts on 2026-08-16 (still fine for enterprise committed-spend
// accounts, which this isn't) -- calls started failing with HTTP 404
// "model_not_found". Groq's own migration guidance points free-tier users
// at openai/gpt-oss-120b as the replacement for the 70b model and
// openai/gpt-oss-20b for the 8b one, so gpt-oss-120b is now primary here
// (gpt-oss-20b, the pre-existing fallback, is proven reliable at this
// task and stays as the fallback). See console.groq.com/docs/deprecations.
var GROQ_MODELS_PARSE = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
var GROQ_MODELS_RANK = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
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
  mode: "list" only if they ask for options/choices/a few ideas, else omit
    (defaults to a single confident pick elsewhere).
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

// Shared low-level Groq call -- both /ai-parse and /ai-rank use this.
// `models` is tried IN ORDER, advancing to the next one only on a 429
// (rate/quota limit) -- Groq's free tier tracks quota per model, so a
// busy day for the first choice doesn't have to mean total failure, just
// a fallback to a less-preferred model until the primary's quota clears.
// Any other failure (network, non-429 HTTP error, bad JSON) fails
// immediately without burning through the fallback list pointlessly.
// Throws Error("request:<detail>") for failures (detail is the upstream
// status/body so failures are actually diagnosable), Error("parse") if
// the model's output isn't valid JSON.
//
// `messages` is the REAL conversation so far (role:"user"/"assistant"
// turns, oldest first) -- not a single flattened string. Passing actual
// multi-turn history is what lets the model resolve "no, somewhere colder"
// or "not that one" against what was actually said earlier, the same way
// any chat model handles a follow-up. response_format:json_object only
// constrains the CURRENT completion, so prior assistant turns being plain
// conversational text (not JSON) is fine.
async function callGroq(env, models, systemPrompt, messages, maxTokens, temperature) {
  let lastErr = null;
  for (const model of models) {
    let resp;
    try {
      resp = await fetch(GROQ_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: model,
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
      throw new Error("request:network error contacting Groq");
    }
    if (!resp.ok) {
      let bodyText = "";
      try { bodyText = (await resp.text()).slice(0, 300); } catch {}
      // Fall back to the next model on quota exhaustion (429), a model-
      // side generation failure (400 json_validate_failed -- seen in
      // practice as an empty completion from the smaller model, not a
      // problem with what we sent), or the model having been retired
      // (404 model_not_found -- happened in practice when Groq deprecated
      // llama-3.3-70b-versatile for free/developer-tier accounts and this
      // wasn't yet treated as fallback-worthy, so every request hard-failed
      // instead of quietly dropping to the next model in the list). Any
      // other failure (genuinely bad request, auth, etc.) fails immediately
      // instead of wasting the rest of the fallback list on something no
      // model will fix.
      if (resp.status === 429 || resp.status === 404 || (resp.status === 400 && bodyText.includes("json_validate_failed"))) {
        lastErr = new Error(`request:Groq HTTP ${resp.status} (${model}) ${bodyText}`);
        continue;
      }
      throw new Error(`request:Groq HTTP ${resp.status} ${bodyText}`);
    }
    try {
      const payload = await resp.json();
      return JSON.parse(payload.choices[0].message.content);
    } catch (e) {
      throw new Error("parse");
    }
  }
  throw lastErr || new Error("request:all models at capacity");
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
  if (parsed.mode === "list" || parsed.mode === "single") out.mode = parsed.mode;
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
  if (!env.GROQ_API_KEY) {
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
    // 1000, not 300 -- the primary (non-reasoning) model never needs
    // anywhere near that for a short JSON object, but the gpt-oss-20b
    // fallback is a reasoning model that burns tokens on invisible
    // chain-of-thought before the visible JSON; too tight a cap here
    // starves it mid-thought and it returns nothing (a real failure seen
    // in testing, not hypothetical). Raising the ceiling costs nothing
    // for the primary path since it's billed on tokens actually used.
    const parsed = await callGroq(env, GROQ_MODELS_PARSE, SYSTEM_PROMPT, history, 2000);
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
  if (!env.GROQ_API_KEY) {
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
    candidates: candidates.map(c => ({
      icao: c.icao, name: c.name, city: c.city, country: c.country,
      ...(c.curatedTier ? { curatedTier: c.curatedTier } : {}),
      ...(Number.isInteger(c.connections) ? { connections: c.connections } : {})
    })),
  });

  try {
    const messages = [...history, { role: "user", content: candidateMsg }];
    const parsed = await callGroq(env, GROQ_MODELS_RANK, RANK_SYSTEM_PROMPT, messages, 2200, 0.3);
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
