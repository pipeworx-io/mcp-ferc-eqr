interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * FERC Electric Quarterly Reports (EQR) — wholesale power sales: who sells
 * to whom, under what contract, at what price and volume.
 *
 * NOT the same dataset as `ferc-elibrary`. `ferc-elibrary` is FERC's docket
 * and document search (filings, orders, opinions — the regulatory PAPER
 * TRAIL). This pack is the underlying TRANSACTION data every public utility,
 * power marketer and generator is required to report each quarter: the
 * sellers, the counterparties, the contracts between them, and (in a later
 * phase) the actual trade-level prices/volumes. A question like "who sells
 * power to PacifiCorp" or "what contracts does NextEra Energy Marketing
 * have on file" has no answer in ferc-elibrary and is exactly what this
 * pack is for.
 *
 * SOURCE: FERC itself publishes EQR only as quarterly nested ZIP files —
 * no query API. Catalyst Cooperative's PUDL project (a widely-used open
 * energy-data project) normalizes EQR into per-quarter Parquet tables and
 * distributes them from a public, keyless S3 bucket
 * (s3://pudl.catalyst.coop/ferceqr/, bucket listing enabled, no auth, no
 * signed URLs). This pack does NOT call that bucket live — the files are
 * bulk Parquet, not a per-query API, so the data is mirrored into our own
 * Supabase tables by scripts/ingest-ferc-eqr.mjs and queried from there.
 *
 * LICENCE / ATTRIBUTION: "Copyright 2016-2026, Catalyst Cooperative,
 * CC-BY-4.0" (https://docs.catalyst.coop/pudl/en/latest/LICENSE.html) —
 * explicit on the DATA (their processing code carries a separate MIT
 * licence that does not apply here). CC-BY-4.0 permits redistribution with
 * attribution, which is why every tool response below carries the
 * `attribution` field. Do not drop it.
 *
 * PHASE 1 ONLY. This pack covers three tables: quarterly_identity (who
 * filed), quarterly_index_pub (who reports to an index price publisher) and
 * contracts (the contract terms themselves — one row per RATE-PERIOD line
 * item within a contract, not one row per contract; see the comment at the
 * top of supabase/migrations/211_ferc_eqr.sql). It does NOT cover
 * `core_ferceqr__transactions` (line-item trade price/volume detail,
 * ~80GB/52 quarters) — see README.md "Phase 2" for that plan. A quantity or
 * rate found here comes from the CONTRACT's stated terms, not from an
 * actual settled trade.
 *
 * NO PERSONAL DATA. The source quarterly_identity table also carries filer
 * CONTACT fields (name, title, address, city, state, zip, country, phone,
 * email — a named individual per filer). None of that is loaded or exposed
 * here — only company-level identity (company_id_ferc, filer_unique_id,
 * company_name). See migration 211's header comment.
 *
 * COVERAGE IS NOT NECESSARILY "ALL QUARTERS SINCE 2013". The upstream source
 * spans 2013q3-2026q2, but the FIRST LOAD is deliberately bounded to recent
 * quarters (Supabase compute has run out before on an unbounded PostgREST
 * backfill from a laptop). Call `eqr_coverage` for the ACTUAL loaded
 * quarter range before assuming a
 * miss means "no such contract" rather than "not loaded yet" — a result
 * outside the covered range is a coverage gap, not a negative answer, and the
 * full 2013-onward history is available on request (a wider `--since`
 * backfill), not automatically loaded.
 *
 * Promoted from mcps/_incubator/ferc-eqr on 2026-09-23 (fleet task #2346)
 * once migration 211 was applied and the first bounded load (last 4
 * quarters) finished. See README.md for the refresh command and the Phase 2
 * plan.
 */


async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'FERC EQR');
}

const ATTRIBUTION =
  'Data: Catalyst Cooperative PUDL (processed from FERC Electric Quarterly Reports), CC-BY-4.0. https://docs.catalyst.coop/pudl/en/latest/LICENSE.html';

const PHASE1_NOTE =
  'Phase 1 coverage only: filer identity, index-price-publisher reporting, and contract terms (one row per contract rate period). Does not include line-item transaction price/volume detail (Phase 2, not yet loaded). Recent quarters loaded first; call eqr_coverage for the exact quarter range currently loaded before treating an empty result as "no such contract" rather than "not loaded yet". Full history back to 2013q3 is available on request, not automatically loaded.';

interface SupabaseConfig { url: string; key: string }

async function pg<T>(cfg: SupabaseConfig, table: string, query: string, extraHeaders?: Record<string, string>): Promise<{ rows: T; total: number | null }> {
  const res = await pwFetch(`${cfg.url}/rest/v1/${table}?${query}`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, ...extraHeaders },
  });
  if (!res.ok) {
    // Never echo the store's raw body or the table name to the caller.
    throw new Error(`FERC EQR data request failed (${res.status}): ${summarizeErrorBody(await res.text())}`);
  }
  const rows = (await res.json()) as T;
  // "0-24/1234" -> 1234. Absent (no Prefer: count=exact) -> null, which is a
  // different fact from 0 rows and must not be reported as 0 (fleet #1081).
  const range = res.headers.get('content-range') ?? '';
  const total = range.includes('/') ? Number(range.split('/')[1]) : null;
  return { rows, total: Number.isFinite(total) ? total : null };
}

async function rpc<T>(cfg: SupabaseConfig, fn: string, body: Record<string, unknown>): Promise<T[]> {
  const res = await pwFetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`FERC EQR data request failed (${res.status}): ${summarizeErrorBody(await res.text())}`);
  return res.json() as Promise<T[]>;
}

function clampLimit(v: unknown, def: number, max: number): number {
  const n = typeof v === 'number' ? Math.floor(v) : def;
  return Math.max(1, Math.min(max, n));
}

const tools: McpToolExport['tools'] = [
  {
    name: 'eqr_seller_lookup',
    description:
      'Find a FERC Electric Quarterly Report filer (seller/power marketer/utility) by name or FERC company id (e.g. "C000740"). Returns their per-quarter filing records — company name(s) as filed and whether they reported transactions to an index price publisher (Argus, ICE, S&P Global/SNL, etc.). Company-level identity only, no filer contact details. Use this to resolve a company name to its company_id_ferc before calling eqr_contracts_search, or to check whether/when a company filed an EQR. Sourced from FERC EQR via PUDL (CC-BY-4.0). Distinct from ferc-elibrary, which is the FERC docket/document search, not filer or transaction data.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Company name (substring match, e.g. "NextEra") or exact FERC company id (e.g. "C000740").' },
        limit: { type: 'number', description: 'Max filing records to return (default 20, max 100).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'eqr_contracts_search',
    description:
      'Search FERC EQR wholesale power contracts by seller, counterparty and/or product. Returns contract-level records: seller, customer, product (e.g. ENERGY, CAPACITY), quantity, rate, rate units, delivery/receipt points, and the contract execution/term dates. Each row is one RATE-PERIOD line item within a contract (a single contract can have several rows for different rate periods) — not a settled trade. Use eqr_seller_lookup first to resolve a company name to a company_id_ferc if you want an exact-seller match rather than a name substring. Sourced from FERC EQR via PUDL (CC-BY-4.0), Phase 1 (contract terms; no transaction-level price/volume yet).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        seller: { type: 'string', description: 'Seller name (substring match) or exact company_id_ferc.' },
        counterparty: { type: 'string', description: 'Counterparty/customer company name, substring match.' },
        product: { type: 'string', description: 'Product name substring, e.g. "ENERGY", "CAPACITY", "TRANSMISSION".' },
        quarter_from: { type: 'string', description: 'Earliest quarter to include, format "2020q1".' },
        quarter_to: { type: 'string', description: 'Latest quarter to include, format "2026q2".' },
        limit: { type: 'number', description: 'Max rows to return (default 20, max 100).' },
        offset: { type: 'number', description: 'Row offset for paging beyond `limit` (default 0).' },
      },
    },
  },
  {
    name: 'eqr_counterparty_sellers',
    description:
      'Who sells wholesale power TO a given counterparty — the reverse of eqr_contracts_search. Aggregates FERC EQR contracts by seller for a counterparty name match, returning each seller\'s contract count, the quarter range they appear in, and the distinct products sold. Answers "who sells power to PacifiCorp" / "which generators have contracts with <utility>" directly, which a single-table filter cannot (it needs a group-by across all matching contracts). Sourced from FERC EQR via PUDL (CC-BY-4.0), Phase 1 (contract terms only).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        counterparty: { type: 'string', description: 'Counterparty/customer company name, substring match, e.g. "PacifiCorp".' },
        quarter_from: { type: 'string', description: 'Earliest quarter to include, format "2020q1".' },
        quarter_to: { type: 'string', description: 'Latest quarter to include, format "2026q2".' },
        limit: { type: 'number', description: 'Max sellers to return (default 25, max 100).' },
      },
      required: ['counterparty'],
    },
  },
  {
    name: 'eqr_coverage',
    description:
      'What FERC EQR data is currently available and how fresh it is: row counts for the filer-identity, index-publisher and contracts tables, the quarter range covered, and when it was last refreshed. Use before relying on a result to confirm coverage includes the quarter you care about. Sourced from FERC EQR via PUDL (CC-BY-4.0).',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

// COMPANY-LEVEL IDENTITY ONLY — no filer contact name/address/phone/email.
// The source Parquet carries those fields; this pack never selects them (see
// migration 211's header and scripts/ingest-ferc-eqr.mjs's NO PERSONAL DATA
// note — the loader does not even read them off the source row).
interface IdentityRow {
  year_quarter: string; filing_quarter: string | null; company_id_ferc: string; filer_unique_id: string | null;
  company_name: string | null; transactions_reported_to_index_price_publishers: boolean | null;
}

interface ContractRow {
  year_quarter: string; seller_company_id_ferc: string; contract_unique_id: string | null;
  seller_company_name: string | null; customer_company_name: string | null; contract_affiliate: boolean | null;
  ferc_tariff_reference: string | null; contract_service_agreement_id: string | null;
  contract_execution_date: string | null; commencement_date_of_contract_term: string | null;
  contract_termination_date: string | null; actual_termination_date: string | null;
  extension_provision_description: string | null; class_name: string | null; term_name: string | null;
  increment_name: string | null; increment_peaking_name: string | null; product_type_name: string | null;
  product_name: string | null; quantity: number | null; units: string | null; rate: number | null;
  rate_minimum: number | null; rate_maximum: number | null; rate_description: string | null;
  rate_units: string | null; point_of_receipt_balancing_authority: string | null;
  point_of_receipt_specific_location: string | null; point_of_delivery_balancing_authority: string | null;
  point_of_delivery_specific_location: string | null; begin_date: string | null; end_date: string | null;
}

interface SellerAgg {
  seller_company_id_ferc: string; seller_company_name: string | null; contract_count: number;
  first_quarter: string; last_quarter: string; products: string[] | null;
}

interface CoverageRow {
  contracts_rows: number; identity_rows: number; index_pub_rows: number;
  quarter_min: string | null; quarter_max: string | null; last_loaded: string | null;
}

/** A bare company_id_ferc looks like "C000740" — 1 letter + digits. */
function looksLikeCompanyId(q: string): boolean {
  return /^[A-Za-z]\d{3,}$/.test(q.trim());
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  if (!url || !key) {
    throw new Error('ferc-eqr is not configured on this deployment — an operator must enable its data credentials. This is a setup problem, not your arguments.');
  }
  const cfg: SupabaseConfig = { url, key };

  switch (name) {
    case 'eqr_seller_lookup': {
      const q = typeof args.query === 'string' ? args.query.trim() : '';
      if (!q) return { found: false, reason: 'no_query', hint: 'Pass query: a company name or a FERC company id like "C000740".' };
      const limit = clampLimit(args.limit, 20, 100);
      const filter = looksLikeCompanyId(q)
        ? `company_id_ferc=eq.${encodeURIComponent(q)}`
        : `company_name=ilike.*${encodeURIComponent(q)}*`;
      const { rows, total } = await pg<IdentityRow[]>(
        cfg, 'ferc_eqr_quarterly_identity',
        [filter, 'order=year_quarter.desc', `limit=${limit}`, 'select=year_quarter,filing_quarter,company_id_ferc,filer_unique_id,company_name,transactions_reported_to_index_price_publishers'].join('&'),
        { Prefer: 'count=exact' },
      );
      if (!rows.length) {
        return {
          found: false,
          result: `No FERC EQR filer matching "${q}".`,
          searched: q, phase1_note: PHASE1_NOTE, attribution: ATTRIBUTION,
        };
      }
      const bySeller = new Map<string, { company_id_ferc: string; company_name: string | null; quarters_filed: string[]; reports_to_index_publisher: boolean }>();
      for (const r of rows) {
        const cur = bySeller.get(r.company_id_ferc) ?? { company_id_ferc: r.company_id_ferc, company_name: r.company_name, quarters_filed: [], reports_to_index_publisher: false };
        cur.quarters_filed.push(r.year_quarter);
        if (r.transactions_reported_to_index_price_publishers) cur.reports_to_index_publisher = true;
        bySeller.set(r.company_id_ferc, cur);
      }
      return {
        found: true,
        matching_filers: bySeller.size,
        filing_records_returned: rows.length,
        filing_records_matched_total: total,
        sellers: [...bySeller.values()],
        latest_filing: rows[0],
        phase1_note: PHASE1_NOTE,
        attribution: ATTRIBUTION,
      };
    }

    case 'eqr_contracts_search': {
      const seller = typeof args.seller === 'string' ? args.seller.trim() : '';
      const counterparty = typeof args.counterparty === 'string' ? args.counterparty.trim() : '';
      const product = typeof args.product === 'string' ? args.product.trim() : '';
      const quarterFrom = typeof args.quarter_from === 'string' ? args.quarter_from.trim() : '';
      const quarterTo = typeof args.quarter_to === 'string' ? args.quarter_to.trim() : '';
      if (!seller && !counterparty && !product) {
        return {
          found: false, reason: 'no_filter',
          hint: 'Pass at least one of seller, counterparty or product — an unfiltered scan of ~9.5M contract rows is not served.',
        };
      }
      const limit = clampLimit(args.limit, 20, 100);
      const offset = Math.max(0, typeof args.offset === 'number' ? Math.floor(args.offset) : 0);
      const filters: string[] = [];
      if (seller) filters.push(looksLikeCompanyId(seller) ? `seller_company_id_ferc=eq.${encodeURIComponent(seller)}` : `seller_company_name=ilike.*${encodeURIComponent(seller)}*`);
      if (counterparty) filters.push(`customer_company_name=ilike.*${encodeURIComponent(counterparty)}*`);
      if (product) filters.push(`product_name=ilike.*${encodeURIComponent(product)}*`);
      if (quarterFrom) filters.push(`year_quarter=gte.${encodeURIComponent(quarterFrom)}`);
      if (quarterTo) filters.push(`year_quarter=lte.${encodeURIComponent(quarterTo)}`);
      filters.push('order=year_quarter.desc', `limit=${limit}`, `offset=${offset}`);
      const { rows, total } = await pg<ContractRow[]>(cfg, 'ferc_eqr_contracts', filters.join('&'), { Prefer: 'count=exact' });
      if (!rows.length) {
        return {
          found: false,
          result: 'No matching FERC EQR contracts.',
          searched: { seller: seller || null, counterparty: counterparty || null, product: product || null, quarter_from: quarterFrom || null, quarter_to: quarterTo || null },
          phase1_note: PHASE1_NOTE, attribution: ATTRIBUTION,
        };
      }
      return {
        found: true,
        contracts_returned: rows.length,
        contracts_matched_total: total,
        next_offset: (total !== null && offset + rows.length < total) ? offset + rows.length : null,
        contracts: rows,
        phase1_note: PHASE1_NOTE,
        attribution: ATTRIBUTION,
      };
    }

    case 'eqr_counterparty_sellers': {
      const counterparty = typeof args.counterparty === 'string' ? args.counterparty.trim() : '';
      if (!counterparty) return { found: false, reason: 'no_query', hint: 'Pass counterparty: the buyer/customer company name to look up sellers for.' };
      const quarterFrom = typeof args.quarter_from === 'string' && args.quarter_from.trim() ? args.quarter_from.trim() : null;
      const quarterTo = typeof args.quarter_to === 'string' && args.quarter_to.trim() ? args.quarter_to.trim() : null;
      const limit = clampLimit(args.limit, 25, 100);
      const sellers = await rpc<SellerAgg>(cfg, 'ferc_eqr_sellers_to_counterparty', {
        counterparty_q: counterparty, quarter_from: quarterFrom, quarter_to: quarterTo, lim: limit,
      });
      if (!sellers.length) {
        return {
          found: false,
          result: `No FERC EQR contracts found with a counterparty matching "${counterparty}".`,
          searched: { counterparty, quarter_from: quarterFrom, quarter_to: quarterTo },
          phase1_note: PHASE1_NOTE, attribution: ATTRIBUTION,
        };
      }
      return {
        found: true,
        counterparty_searched: counterparty,
        sellers_found: sellers.length,
        sellers,
        phase1_note: PHASE1_NOTE,
        attribution: ATTRIBUTION,
      };
    }

    case 'eqr_coverage': {
      const [c] = await rpc<CoverageRow>(cfg, 'ferc_eqr_coverage', {});
      return {
        found: true,
        contracts_rows: c?.contracts_rows ?? 0,
        identity_rows: c?.identity_rows ?? 0,
        index_pub_rows: c?.index_pub_rows ?? 0,
        quarter_range: c ? { from: c.quarter_min, to: c.quarter_max } : null,
        data_as_of: c?.last_loaded ?? null,
        phase1_note: PHASE1_NOTE,
        attribution: ATTRIBUTION,
      };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export default { tools, callTool } satisfies McpToolExport;
