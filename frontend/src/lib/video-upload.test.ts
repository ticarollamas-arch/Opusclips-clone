import { uploadTooLargeMessage, uploadVideoFile, validateVideoSourceUrl } from "./video-upload";

describe("S3 video uploads", () => {
  it("rejects a file over the upload limit before requesting authorization", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["x"], "video.mp4", { type: "video/mp4" });
    Object.defineProperty(file, "size", { value: 4_000_000_001 });
    await expect(uploadVideoFile(file, 4_000_000_000)).rejects.toThrow(uploadTooLargeMessage(4_000_000_000, file.size));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  afterEach(() => vi.unstubAllGlobals());

  function authorization() {
    return { storage: "s3", video_path: "upload://s3/owner/id/video.mp4", uploadId: "upload",
      partSize: 3, parts: [{ partNumber: 1, url: "https://s3.test/1" }, { partNumber: 2, url: "https://s3.test/2" }] };
  }

  it("uploads parts directly and completes them in order", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload/authorization") return Response.json(authorization());
      if (url.startsWith("https://s3.test/")) return new Response(null, { headers: { ETag: url.endsWith("1") ? "first" : "second" } });
      if (url === "/api/upload/complete") {
        expect(JSON.parse(init?.body as string).parts).toEqual([{ partNumber: 1, etag: "first" }, { partNumber: 2, etag: "second" }]);
        return Response.json({ video_path: authorization().video_path });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["abcdef"], "video.mp4", { type: "video/mp4" });
    await expect(uploadVideoFile(file)).resolves.toBe(authorization().video_path);
    const puts = fetchMock.mock.calls.filter(([url]) => url.startsWith("https://s3.test/"));
    expect(puts).toHaveLength(2);
    expect(puts.every(([, init]) => init?.method === "PUT" && (init.body as Blob).size === 3)).toBe(true);
    expect(puts.every(([, init]) => !init?.headers)).toBe(true);
  });

  it("aborts the multipart upload when a part fails", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/upload/authorization") return Response.json(authorization());
      if (url.startsWith("https://s3.test/")) return new Response(null, { status: 503 });
      if (url === "/api/upload/abort") return Response.json({ message: "cancelled" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(new File(["abcdef"], "video.mp4"))).rejects.toThrow("Video upload failed");
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/upload/abort")).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/upload/complete")).toBe(false);
  });

  it("refreshes expired part URLs without discarding completed parts", async () => {
    let refreshes = 0;
    let completions = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload/authorization") return Response.json(authorization());
      if (url === "https://s3.test/1") return new Response(null, { headers: { ETag: "first" } });
      if (url === "https://s3.test/2") return new Response(null, { status: 403 });
      if (url === "/api/upload/parts") {
        expect(JSON.parse(init?.body as string).partNumbers).toEqual([2]);
        refreshes++;
        return Response.json({ parts: [{ partNumber: 2, url: "https://s3.test/fresh" }] });
      }
      if (url === "https://s3.test/fresh") return new Response(null, { headers: { ETag: "second" } });
      if (url === "/api/upload/complete") {
        completions++;
        if (completions === 1) return new Response(null, { status: 503 });
        expect(JSON.parse(init?.body as string).parts).toEqual([{ partNumber: 1, etag: "first" }, { partNumber: 2, etag: "second" }]);
        return Response.json({ video_path: authorization().video_path });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(new File(["abcdef"], "video.mp4"))).resolves.toBe(authorization().video_path);
    expect(refreshes).toBe(1);
    expect(completions).toBe(2);
    expect(fetchMock.mock.calls.filter(([url]) => url === "https://s3.test/1")).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/upload/abort")).toBe(false);
  });

});

describe("chunked video uploads", () => {
  const API = "https://api.test";
  const base = `${API}/upload/chunked`;
  const signed = { "x-supoclip-user-id": "user", "x-supoclip-ts": "1", "x-supoclip-signature": "first" };
  const realSetTimeout = globalThis.setTimeout;
  // Retry waits last seconds; run them at once and leave request timeouts alone.
  const instantBackoff = () => vi.stubGlobal("setTimeout", (callback: () => void, ms?: number) => realSetTimeout(callback, ms !== undefined && ms >= 1000 && ms < 60_000 ? 0 : ms));
  const authorization = (headers: Record<string, string> = signed) => Response.json({ directUpload: true, uploadUrl: `${API}/upload`, headers });
  const started = () => Response.json({ upload_id: "abc123", chunk_size: 4, total_parts: 3, received: [] });
  const file = () => new File(["abcdefghij"], "video.mp4", { type: "video/mp4" });
  const step = (url: string, init?: RequestInit) => `${init?.method} ${url.replace(base, "")}`;

  afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.lang = "";
  });

  it("sends the video in parts, reports progress and returns the stored path", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload/authorization") return authorization();
      if (url === `${base}/init`) return started();
      if (url.startsWith(`${base}/abc123/parts/`)) return Response.json({ received: 1 });
      if (url === `${base}/abc123/complete`) return Response.json({ video_path: "upload://stored.mp4" });
      throw new Error(`Unexpected request: ${step(url, init)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const progress: number[] = [];
    await expect(uploadVideoFile(file(), 4_000_000_000, (fraction) => progress.push(fraction))).resolves.toBe("upload://stored.mp4");
    const api = fetchMock.mock.calls.filter(([url]) => url.startsWith(API));
    expect(api.map(([url, init]) => step(url, init))).toEqual([
      "POST /init", "PUT /abc123/parts/0", "PUT /abc123/parts/1", "PUT /abc123/parts/2", "POST /abc123/complete",
    ]);
    expect(api.filter(([, init]) => init?.method === "PUT").map(([, init]) => (init?.body as Blob).size)).toEqual([4, 4, 2]);
    expect(JSON.parse(api[0][1]?.body as string)).toEqual({ filename: "video.mp4", size: 10, contentType: "video/mp4" });
    expect(api.every(([, init]) => (init?.headers as Record<string, string>)["x-supoclip-signature"] === "first")).toBe(true);
    expect(progress).toEqual([0, 0.4, 0.8, 1, 1]);
  });

  it("sends a part again after a network error without resending earlier parts", async () => {
    instantBackoff();
    let failures = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/upload/authorization") return authorization();
      if (url === `${base}/init`) return started();
      if (url === `${base}/abc123/parts/1` && failures++ < 2) throw new TypeError("Failed to fetch");
      if (url.startsWith(`${base}/abc123/parts/`)) return Response.json({ received: 1 });
      if (url === `${base}/abc123/complete`) return Response.json({ video_path: "upload://stored.mp4" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(file())).resolves.toBe("upload://stored.mp4");
    const count = (suffix: string) => fetchMock.mock.calls.filter(([url]) => url === `${base}/abc123/${suffix}`).length;
    expect([count("parts/0"), count("parts/1"), count("parts/2"), count("complete")]).toEqual([1, 3, 1, 1]);
  });

  it("retries gateway errors but not a refusal", async () => {
    instantBackoff();
    let gateway = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/upload/authorization") return authorization();
      if (url === `${base}/init`) return gateway++ < 2 ? new Response(null, { status: 502 }) : started();
      if (url === `${base}/abc123/parts/0`) return Response.json({ detail: "Invalid part number." }, { status: 400 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(file())).rejects.toThrow("Invalid part number.");
    expect(fetchMock.mock.calls.filter(([url]) => url === `${base}/init`)).toHaveLength(3);
    expect(fetchMock.mock.calls.filter(([url]) => url === `${base}/abc123/parts/0`)).toHaveLength(1);
  });

  it("asks for new signed headers when the server rejects the signature", async () => {
    instantBackoff();
    let authorizations = 0;
    let rejected = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload/authorization") return authorization(authorizations++ === 0 ? signed : { ...signed, "x-supoclip-signature": "second" });
      if (url === `${base}/init`) return started();
      if (url === `${base}/abc123/parts/0` && !rejected) { rejected = true; return Response.json({ detail: "expired" }, { status: 401 }); }
      if (url.startsWith(`${base}/abc123/parts/`)) return Response.json({ received: 1 });
      if (url === `${base}/abc123/complete`) return Response.json({ video_path: "upload://stored.mp4" });
      throw new Error(`Unexpected request: ${step(url, init)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(file())).resolves.toBe("upload://stored.mp4");
    const partZero = fetchMock.mock.calls.filter(([url]) => url === `${base}/abc123/parts/0`);
    expect(partZero.map(([, init]) => (init?.headers as Record<string, string>)["x-supoclip-signature"])).toEqual(["first", "second"]);
  });

  it("sends only the parts the server reports missing when complete answers 409", async () => {
    let completions = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload/authorization") return authorization();
      if (url === `${base}/init`) return started();
      if (url === `${base}/abc123` && init?.method === "GET") return Response.json({ received: [0, 2], total_parts: 3 });
      if (url.startsWith(`${base}/abc123/parts/`)) return Response.json({ received: 1 });
      if (url === `${base}/abc123/complete`) {
        return completions++ === 0 ? Response.json({ detail: "1 part(s) of the video are missing." }, { status: 409 }) : Response.json({ video_path: "upload://stored.mp4" });
      }
      throw new Error(`Unexpected request: ${step(url, init)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(file())).resolves.toBe("upload://stored.mp4");
    const api = fetchMock.mock.calls.filter(([url]) => url.startsWith(API)).map(([url, init]) => step(url, init));
    expect(api.slice(-4)).toEqual(["POST /abc123/complete", "GET /abc123", "PUT /abc123/parts/1", "POST /abc123/complete"]);
  });

  it("gives a readable message and frees the server when a part keeps failing", async () => {
    instantBackoff();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload/authorization") return authorization();
      if (url === `${base}/init`) return started();
      if (url === `${base}/abc123/parts/1`) throw new TypeError("Failed to fetch");
      if (url === `${base}/abc123` && init?.method === "DELETE") return Response.json({ message: "Upload cancelled" });
      if (url.startsWith(`${base}/abc123/parts/`)) return Response.json({ received: 1 });
      throw new Error(`Unexpected request: ${step(url, init)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(file())).rejects.toThrow("Video upload failed (part 2 of 3): no connection to the server. Check your connection and try again.");
    expect(fetchMock.mock.calls.filter(([url]) => url === `${base}/abc123/parts/1`)).toHaveLength(6);
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    expect(fetchMock.mock.calls.some(([url, init]) => url === `${base}/abc123` && init?.method === "DELETE")).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => url === `${base}/abc123/complete`)).toBe(false);
  });

  it("writes the failure message in Portuguese when the page is Portuguese", async () => {
    instantBackoff();
    document.documentElement.lang = "pt-BR";
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/upload/authorization") return authorization();
      throw new TypeError("Failed to fetch");
    }));
    await expect(uploadVideoFile(file())).rejects.toThrow("Falha no envio do vídeo (início do envio): sem conexão com o servidor. Confira a internet e tente de novo.");
  });

  it("shows the usual too-large message when the server refuses the size", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/api/upload/authorization") return authorization();
      if (url === `${base}/init`) return Response.json({ detail: "too large" }, { status: 413 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    await expect(uploadVideoFile(file(), 1000)).rejects.toThrow(uploadTooLargeMessage(1000));
  });

  it("falls back to one request when the backend has no chunked endpoints", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/upload/authorization") return authorization();
      if (url === `${base}/init`) return Response.json({ detail: "Not Found" }, { status: 404 });
      if (url === `${API}/upload`) {
        expect((init?.body as FormData).get("video")).toBeInstanceOf(File);
        return Response.json({ video_path: "upload://single.mp4" });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(uploadVideoFile(file())).resolves.toBe("upload://single.mp4");
  });

  it("does not send anything while the page is hidden", async () => {
    let visibility = "hidden";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/upload/authorization") return authorization();
      if (url === `${base}/init`) return started();
      if (url.startsWith(`${base}/abc123/parts/`)) return Response.json({ received: 1 });
      if (url === `${base}/abc123/complete`) return Response.json({ video_path: "upload://stored.mp4" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const upload = uploadVideoFile(file());
      await new Promise((resolve) => realSetTimeout(resolve, 20));
      expect(fetchMock.mock.calls.filter(([url]) => url.startsWith(API))).toHaveLength(0);
      visibility = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await expect(upload).resolves.toBe("upload://stored.mp4");
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
    }
  });
});

describe("supported video source URLs", () => {
  it.each([["https://www.youtube.com/watch?v=abcdefghijk", "youtube"], ["https://www.twitch.tv/videos/12345", "twitch"], ["https://clips.twitch.tv/FancyClip-abc", "twitch"], ["https://kick.com/creator/videos/12345678-1234-1234-1234-123456789abc", "kick"], ["https://kick.com/video/12345678-1234-1234-1234-123456789abc", "kick"], ["https://kick.com/creator/clips/clip_abc", "kick"]])("accepts %s", (url, source) => expect(validateVideoSourceUrl(url)).toEqual({ source }));
  // Issue #287: Shorts and other share links were rejected by a narrower copy of the parser.
  it.each([
    "https://www.youtube.com/shorts/ai1gIWacf0I",
    "https://youtube.com/shorts/ai1gIWacf0I?si=abc",
    "https://m.youtube.com/watch?v=ai1gIWacf0I",
    "https://music.youtube.com/watch?v=ai1gIWacf0I",
    "https://youtu.be/ai1gIWacf0I?t=3",
    "https://www.youtube.com/live/ai1gIWacf0I",
    "https://www.youtube.com/embed/ai1gIWacf0I",
  ])("accepts YouTube link %s", (url) => expect(validateVideoSourceUrl(url)).toEqual({ source: "youtube" }));
  it("rejects a YouTube page that is not a video", () => expect(validateVideoSourceUrl("https://www.youtube.com/@creator").error).toBe("Enter a valid YouTube video URL."));
  it.each(["https://twitch.tv/creator", "https://kick.com/creator"])("rejects live URL %s", (url) => expect(validateVideoSourceUrl(url).error).toContain("Live streams aren't supported"));
  it.each([
    ["https://www.twitch.tv/videos", "Enter a valid Twitch VOD or clip URL."],
    ["https://www.twitch.tv/creator/videos", "Enter a valid Twitch VOD or clip URL."],
    ["https://kick.com/creator/about", "Enter a valid Kick VOD or clip URL."],
    ["https://kick.com/video/not-a-uuid", "Enter a valid Kick VOD or clip URL."],
  ])("gives an unsupported-URL message for %s", (url, message) => expect(validateVideoSourceUrl(url).error).toBe(message));
});
