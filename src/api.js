import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { ApiError, MAX_BODY_BYTES, validateEvent, validateIdempotencyKey, validateSearch } from './domain.js';
import { parseUnambiguousJson } from './strict-json.js';
import { StoreUnavailableError } from './store.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function digest(value) { return createHash('sha256').update(value).digest(); }

/** Exact-match bearer key authentication; write/read scopes are separated. */
function authorize(req, secretDigest) {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer +([A-Za-z0-9_-]+)$/i.exec(header) : null;
  const token = match?.[1] ?? '';
  const matched = timingSafeEqual(digest(token), secretDigest);
  if (!token || !matched) {
    throw new ApiError(401, 'Unauthorized', 'Valid Bearer token required for this operation', 'unauthorized');
  }
}

function writeJson(res, status, body, requestId, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'x-request-id': requestId,
    ...extraHeaders
  });
  res.end(data);
}

function writeProblem(res, status, title, detail, requestId, code, headers = {}) {
  const data = JSON.stringify({ type: 'about:blank', title, status, detail, code, requestId });
  res.writeHead(status, {
    'content-type': 'application/problem+json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId,
    ...headers
  });
  res.end(data);
}

async function readJsonBody(req) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' ||
      !/^application\/json(?:[ \t]*;[ \t]*charset[ \t]*=[ \t]*(?:utf-8|"utf-8"))?[ \t]*$/i.test(contentType)) {
    throw new ApiError(415, 'Unsupported Media Type', 'Expected Content-Type: application/json', 'unsupported_media_type');
  }
  const contentLength = req.headers['content-length'];
  if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BODY_BYTES)) {
    throw new ApiError(413, 'Payload Too Large', `Request body must not exceed ${MAX_BODY_BYTES} bytes`, 'payload_too_large');
  }
  const parts = [];
  let bytes = 0;
  for await (const part of req) {
    bytes += part.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      req.resume();
      throw new ApiError(413, 'Payload Too Large', `Request body must not exceed ${MAX_BODY_BYTES} bytes`, 'payload_too_large');
    }
    parts.push(part);
  }
  if (bytes === 0) throw new ApiError(400, 'Bad Request', 'Request body must not be empty', 'validation_error');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)); }
  catch { throw new ApiError(400, 'Bad Request', 'Request body is not valid UTF-8', 'validation_error'); }
  return parseUnambiguousJson(text);
}

/** The HTTP adapter contains no SQL. Route decisions are intentionally explicit. */
export function createApi(store, config, logger = console) {
  const writeDigest = digest(config.writeKey);
  const readDigest = digest(config.readKey);
  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const start = performance.now();
    let status = 500;
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      if ((req.method === 'GET' || req.method === 'HEAD') && path === '/health/live') {
        status = 200;
        writeJson(res, status, { status: 'ok' }, requestId);
      } else if (req.method === 'GET' && path === '/health/ready') {
        const ready = store.ready();
        status = ready ? 200 : 503;
        writeJson(res, status, { status: ready ? 'ready' : 'unavailable' }, requestId);
      } else if (req.method === 'POST' && path === '/v1/events') {
        authorize(req, writeDigest);
        const body = await readJsonBody(req);
        const event = validateEvent(body);
        const idempotencyKeyHeader = req.headers['idempotency-key'];
        const idempotencyKey = validateIdempotencyKey(idempotencyKeyHeader);
        const result = store.append(event, config.serviceId, idempotencyKey);
        if (result.kind === 'conflict') {
          throw new ApiError(409, 'Conflict', 'Idempotency-Key was already used for a different event', 'idempotency_conflict');
        }
        status = result.kind === 'replayed' ? 200 : 201;
        writeJson(res, status, { data: result.event }, requestId, {
          location: `/v1/events/${result.event.id}`,
          ...(result.kind === 'replayed' ? { 'idempotent-replayed': 'true' } : {})
        });
      } else if (req.method === 'GET' && path === '/v1/events') {
        authorize(req, readDigest);
        const query = validateSearch(url.searchParams);
        const result = store.list(query);
        status = 200;
        writeJson(res, status, result, requestId);
      } else if (path.startsWith('/v1/events/') && req.method === 'GET') {
        authorize(req, readDigest);
        const id = path.slice('/v1/events/'.length);
        if (!UUID_RE.test(id)) throw new ApiError(400, 'Bad Request', 'Invalid event identifier', 'validation_error');
        const event = store.getById(id.toLowerCase());
        if (!event) throw new ApiError(404, 'Not Found', 'Event not found', 'not_found');
        status = 200;
        writeJson(res, status, { data: event }, requestId);
      } else if (path === '/v1/events' || path.startsWith('/v1/events/')) {
        status = 405;
        writeProblem(res, status, 'Method Not Allowed', 'This operation is not supported', requestId,
          'method_not_allowed', { allow: path === '/v1/events' ? 'GET, POST' : 'GET' });
      } else {
        status = 404;
        writeProblem(res, status, 'Not Found', 'Route not found', requestId, 'not_found');
      }
    } catch (err) {
      if (err instanceof StoreUnavailableError) {
        status = err.status;
        writeProblem(res, status, status === 507 ? 'Insufficient Storage' : 'Service Unavailable',
          status === 507 ? 'Audit storage capacity is exhausted' : 'Audit service integrity is unavailable',
          requestId, err.code);
      } else if (err instanceof ApiError) {
        status = err.status;
        writeProblem(res, status, err.title, err.message, requestId, err.code,
          status === 401 ? { 'www-authenticate': 'Bearer realm="audit-trail"' } :
          (status === 413 || status === 415 ? { connection: 'close' } : {}));
      } else {
        status = 500;
        // Do not log request body, Authorization, actor IDs, or metadata.
        logger.error?.(JSON.stringify({ level: 'error', requestId, message: 'Unexpected API failure',
          errorType: err?.constructor?.name ?? 'Error' }));
        if (!res.headersSent) writeProblem(res, status, 'Internal Server Error',
          'An unexpected error occurred', requestId, 'internal_error');
        else res.destroy();
      }
    } finally {
      logger.info?.(JSON.stringify({ level: 'info', requestId, method: req.method,
        status, elapsedMs: Number((performance.now() - start).toFixed(2)) }));
    }
  });
}
