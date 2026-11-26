/**
 * Chunked video upload straight to the backend.
 *
 * A proxy in front of the API (the free Cloudflare tunnel, for one) rejects
 * request bodies above 100 MB, and the browser then shows a bare "Failed to
 * fetch". Sending the video in small parts keeps every request far below that
 * limit, and a dropped connection only costs the part in flight: each part is
 * retried on its own, after waiting for the network and the tab to come back.
 */
import { formatSupportMessage, parseApiError } from "@/lib/api-error";

export type UploadProgressHandler = (fraction: number) => void;

export type ChunkedUploadOptions = {
  /** Upload URL from the authorization, e.g. https://api.example.com/upload */
  uploadUrl: string;
  /** Signed backend headers from the authorization. */
  headers: Record<string, string>;
  /** Fetches fresh signed headers; the backend accepts a signature for a few minutes only. */
  refreshHeaders: () => Promise<Record<string, string> | null>;
  /** Shown when the server answers 413. */
  tooLargeMessage: string;
  onProgress?: UploadProgressHandler;
};

const PART_TIMEOUT_MS = 300_000;
const CONTROL_TIMEOUT_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 180_000;
const PART_ATTEMPTS = 6;
const CONTROL_ATTEMPTS = 4;
const OFFLINE_WAIT_MS = 60_000;
// The backend accepts a signature for 5 minutes; renew well before that.
const HEADERS_MAX_AGE_MS = 120_000;
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
// Timeouts and gateway errors pass on their own; anything else is the answer.
const RETRY_STATUSES = new Set([408, 425, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

type Step = { kind: "start" } | { kind: "part"; number: number; total: number } | { kind: "finish" };
type Problem = "network" | "timeout" | number;

function say(portuguese: string, english: string): string {
  const language =
    typeof document !== "undefined" && document.documentElement.lang
      ? document.documentElement.lang
      : typeof navigator !== "undefined"
        ? navigator.language
        : "";
  return language.toLowerCase().startsWith("pt") ? portuguese : english;
}

function stepLabel(step: Step): string {
  if (step.kind === "part") return say(`pedaço ${step.number} de ${step.total}`, `part ${step.number} of ${step.total}`);
  return step.kind === "start" ? say("início do envio", "starting") : say("fim do envio", "finishing");
}

function problemLabel(problem: Problem): string {
  if (problem === "network") return say("sem conexão com o servidor", "no connection to the server");
  if (problem === "timeout") return say("o servidor demorou demais para responder", "the server took too long to answer");
  return say(`o servidor respondeu com erro ${problem}`, `the server answered with error ${problem}`);
}

function gaveUpMessage(step: Step, problem: Problem): string {
  return say(
    `Falha no envio do vídeo (${stepLabel(step)}): ${problemLabel(problem)}. Confira a internet e tente de novo.`,
    `Video upload failed (${stepLabel(step)}): ${problemLabel(problem)}. Check your connection and try again.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextEvent(target: EventTarget, type: string, timeoutMs?: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      target.removeEventListener(type, done);
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(done, timeoutMs);
    target.addEventListener(type, done);
  });
}

/**
 * A phone that locks its screen freezes the page and drops its connections.
 * Wait for the tab to be visible again, and briefly for the network, instead
 * of burning retries that cannot work.
 */
async function waitUntilUsable(): Promise<void> {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  while (document.visibilityState === "hidden") await nextEvent(document, "visibilitychange");
  if (navigator.onLine === false) await nextEvent(window, "online", OFFLINE_WAIT_MS);
}

type Transport = {
  base: string;
  headers: () => Promise<Record<string, string>>;
  /** Marks the signed headers as rejected so the next request renews them. */
  expire: () => void;
};

function createTransport(options: ChunkedUploadOptions): Transport {
  let headers = options.headers;
  let issuedAt = Date.now();
  let expired = false;
  return {
    base: `${options.uploadUrl.replace(/\/+$/, "")}/chunked`,
    async headers() {
      if (expired || Date.now() - issuedAt > HEADERS_MAX_AGE_MS) {
        const fresh = await options.refreshHeaders();
        if (fresh) headers = fresh;
        issuedAt = Date.now();
        expired = false;
      }
      return headers;
    },
    expire() {
      expired = true;
    },
  };
}

type RequestSpec = { method: string; headers?: Record<string, string>; body?: Blob | string };

/** Sends one request, retrying network failures, timeouts and gateway errors. */
async function send(
  transport: Transport,
  path: string,
  request: RequestSpec,
  step: Step,
  timeoutMs: number,
  attempts: number,
): Promise<Response> {
  let problem: Problem = "network";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await waitUntilUsable();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const signed = await transport.headers();
      const response = await fetch(`${transport.base}${path}`, {
        method: request.method,
        headers: { ...signed, ...request.headers },
        body: request.body,
        signal: controller.signal,
      });
      if (response.ok) return response;
      if (response.status === 401 && attempt < attempts) {
        transport.expire();
        problem = 401;
        continue;
      }
      if (!RETRY_STATUSES.has(response.status)) return response;
      problem = response.status;
    } catch {
      problem = controller.signal.aborted ? "timeout" : "network";
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await sleep(BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)]);
  }
  throw new Error(gaveUpMessage(step, problem));
}

async function failureFrom(response: Response, step: Step, tooLargeMessage: string): Promise<Error> {
  switch (response.status) {
    case 401:
    case 403:
      return new Error(say("Não foi possível autenticar o envio. Atualize a página e tente de novo.", "The upload could not be authenticated. Reload the page and try again."));
    case 404:
      return new Error(say("O envio expirou no servidor. Envie o vídeo de novo.", "The upload expired on the server. Please send the video again."));
    case 413:
      return new Error(tooLargeMessage);
    case 429:
      return new Error(say("Limite de envios atingido. Tente de novo mais tarde.", "Upload limit reached. Please try again later."));
    case 507:
      return new Error(say("O servidor está sem espaço para este vídeo. Tente mais tarde.", "The server has no space for this video. Please try later."));
  }
  const info = await parseApiError(response, gaveUpMessage(step, response.status));
  return new Error(formatSupportMessage(info));
}

type Started = { uploadId: string; chunkSize: number; totalParts: number; received: number[] };

function readStarted(value: unknown): Started | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const chunkSize = data.chunk_size;
  const totalParts = data.total_parts;
  if (typeof data.upload_id !== "string" || !data.upload_id) return null;
  if (typeof chunkSize !== "number" || !Number.isInteger(chunkSize) || chunkSize <= 0) return null;
  if (typeof totalParts !== "number" || !Number.isInteger(totalParts) || totalParts <= 0) return null;
  const received = Array.isArray(data.received) ? data.received.filter((n): n is number => Number.isInteger(n)) : [];
  return { uploadId: data.upload_id, chunkSize, totalParts, received };
}

/**
 * Uploads `file` in parts and returns its `upload://` path.
 * Returns null when the server has no chunked endpoint (an older backend), so
 * the caller can send the file in a single request instead.
 */
export async function uploadVideoInChunks(file: File, options: ChunkedUploadOptions): Promise<string | null> {
  const transport = createTransport(options);
  const startStep: Step = { kind: "start" };
  const finishStep: Step = { kind: "finish" };

  const startResponse = await send(
    transport,
    "/init",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: file.name, size: file.size, contentType: file.type }),
    },
    startStep,
    CONTROL_TIMEOUT_MS,
    CONTROL_ATTEMPTS,
  );
  if (startResponse.status === 404 || startResponse.status === 405) return null;
  if (!startResponse.ok) throw await failureFrom(startResponse, startStep, options.tooLargeMessage);
  const started = readStarted(await startResponse.json().catch(() => null));
  if (!started) {
    throw new Error(say("O servidor respondeu algo inesperado ao iniciar o envio.", "The server sent an unexpected answer when starting the upload."));
  }

  const { uploadId, chunkSize, totalParts } = started;
  const sessionPath = `/${encodeURIComponent(uploadId)}`;
  const stored = new Set<number>(started.received);
  const partBytes = (index: number) => Math.min(chunkSize, file.size - index * chunkSize);
  const report = () => {
    let done = 0;
    for (const index of stored) done += partBytes(index);
    options.onProgress?.(Math.min(1, done / file.size));
  };

  const sendPart = async (index: number) => {
    const step: Step = { kind: "part", number: index + 1, total: totalParts };
    const start = index * chunkSize;
    const response = await send(
      transport,
      `${sessionPath}/parts/${index}`,
      { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file.slice(start, start + partBytes(index)) },
      step,
      PART_TIMEOUT_MS,
      PART_ATTEMPTS,
    );
    if (!response.ok) throw await failureFrom(response, step, options.tooLargeMessage);
    stored.add(index);
    report();
  };

  // Asks the server what it has and sends only the rest. False when nothing is missing.
  const sendMissingParts = async (): Promise<boolean> => {
    const response = await send(transport, sessionPath, { method: "GET" }, finishStep, CONTROL_TIMEOUT_MS, CONTROL_ATTEMPTS);
    if (!response.ok) return false;
    const status = (await response.json().catch(() => null)) as { received?: unknown } | null;
    stored.clear();
    if (Array.isArray(status?.received)) for (const n of status.received) if (Number.isInteger(n)) stored.add(n as number);
    const missing = Array.from({ length: totalParts }, (_, index) => index).filter((index) => !stored.has(index));
    for (const index of missing) await sendPart(index);
    return missing.length > 0;
  };

  try {
    report();
    for (let index = 0; index < totalParts; index++) {
      if (!stored.has(index)) await sendPart(index);
    }
    for (let round = 0; ; round++) {
      const response = await send(transport, `${sessionPath}/complete`, { method: "POST" }, finishStep, COMPLETE_TIMEOUT_MS, CONTROL_ATTEMPTS);
      if (response.ok) {
        const result = (await response.json().catch(() => null)) as { video_path?: unknown } | null;
        if (typeof result?.video_path !== "string" || !result.video_path) {
          throw new Error(say("O envio terminou sem o caminho do vídeo. Tente de novo.", "Upload finished without a video path. Please try again."));
        }
        options.onProgress?.(1);
        return result.video_path;
      }
      // 409: the server is missing parts (for example one whose answer was lost).
      if (response.status === 409 && round < 2 && (await sendMissingParts())) continue;
      throw await failureFrom(response, finishStep, options.tooLargeMessage);
    }
  } catch (error) {
    // Free the server's disk; the user starts over with a fresh session.
    void transport
      .headers()
      .then((signed) => fetch(`${transport.base}${sessionPath}`, { method: "DELETE", headers: signed }))
      .catch(() => undefined);
    throw error;
  }
}
