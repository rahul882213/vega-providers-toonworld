const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const { transformSync } = require("esbuild");
const cheerio = require("cheerio");

function loadModule(name) {
  const mod = { exports: {} };
  const rawCode = fs.readFileSync(`providers/toonworld4all/${name}.ts`, "utf8");
  const code = transformSync(rawCode, { loader: "ts", format: "cjs" }).code;
  new Function("module", "exports", "require", code)(
    mod,
    mod.exports,
    (key) => {
      if (key === "../providerErrors") {
        return {
          throwProviderError: (_p, _f, err) => {
            throw err;
          },
        };
      }
      if (key === "../extractors/hubcloud") {
        return {
          hubcloudExtractor: async (link, _signal, _axios, _cheerio, _headers, _context, _isDl) => {
            if (link.includes("broken")) throw new Error("Upstream 404");
            return [
              {
                server: "CF Storage",
                link: "https://cf.example.com/file.mkv",
                type: "mkv",
                quality: "720",
              },
            ];
          },
        };
      }
      if (key === "../extractors/gdflix") {
        return {
          gdflixExtractor: async (link) => {
            if (link.includes("broken")) throw new Error("WAF 403");
            return [
              {
                server: "ResumeCloud",
                link: "https://gdflix.example.com/download.mkv",
                type: "mkv",
              },
            ];
          },
        };
      }
      return {};
    },
  );
  return mod.exports;
}

function createMockContext(mockResponses = {}) {
  return {
    cheerio,
    commonHeaders: { "User-Agent": "MockAgent/1.0" },
    axios: {
      get: async (url) => {
        if (mockResponses[url]) {
          return { data: mockResponses[url], status: 200 };
        }
        for (const [key, val] of Object.entries(mockResponses)) {
          if (url.includes(key)) {
            return { data: val, status: 200 };
          }
        }
        throw new Error(`Unhandled mock URL: ${url}`);
      },
    },
  };
}

test("meta.ts extracts series metadata and archive episode links", async () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Naruto Shippuden - Toonworld4all</title>
        <meta property="og:title" content="Naruto Shippuden Season 18" />
        <meta property="og:image" content="https://img.example/poster.jpg" />
        <meta property="og:description" content="Naruto Shippuden Season 18 full episodes." />
      </head>
      <body>
        <h1 class="entry-title">Naruto Shippuden Season 18</h1>
        <div class="entry-content">
          <p><a href="https://archive.toonworld4all.me/episode/naruto-1x1">Episode 1</a></p>
          <p><a href="https://archive.toonworld4all.me/episode/naruto-1x2">Episode 2</a></p>
        </div>
      </body>
    </html>
  `;
  const ctx = createMockContext({ "toonworld4all.me/naruto": html });
  const metaMod = loadModule("meta");
  const meta = await metaMod.getMeta({
    link: "https://toonworld4all.me/naruto",
    providerContext: ctx,
  });

  assert.equal(meta.title, "Naruto Shippuden Season 18");
  assert.equal(meta.type, "series");
  assert.equal(meta.image, "https://img.example/poster.jpg");
  assert.equal(meta.synopsis, "Naruto Shippuden Season 18 full episodes.");
  assert.equal(meta.linkList.length, 1);
  assert.equal(meta.linkList[0].directLinks.length, 2);
  assert.equal(
    meta.linkList[0].directLinks[0].link,
    "https://archive.toonworld4all.me/episode/naruto-1x1",
  );
});

test("meta.ts extracts movie metadata from archive /movie/ links", async () => {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>The Royal Cat (2024)</title>
        <meta property="og:image" content="https://img.example/cat.jpg" />
      </head>
      <body>
        <h1 class="entry-title">The Royal Cat (2024)</h1>
        <div class="entry-content">
          <p><a href="https://archive.toonworld4all.me/movie/royal-cat-2024">Watch Movie</a></p>
        </div>
      </body>
    </html>
  `;
  const ctx = createMockContext({ "toonworld4all.me/royal-cat": html });
  const metaMod = loadModule("meta");
  const meta = await metaMod.getMeta({
    link: "https://toonworld4all.me/royal-cat",
    providerContext: ctx,
  });

  assert.equal(meta.title, "The Royal Cat (2024)");
  assert.equal(meta.type, "movie");
  assert.equal(meta.linkList.length, 1);
  assert.equal(
    meta.linkList[0].directLinks[0].link,
    "https://archive.toonworld4all.me/movie/royal-cat-2024",
  );
});

test("stream.ts extracts direct web player stream from window.__PROPS__", async () => {
  const episodeHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Watch Episode</title></head>
      <body>
        <div id="root"></div>
        <script>
          window.__PAGE__ = "episode";
          window.__PROPS__ = {
            data: {
              data: {
                streams: [
                  {
                    play: "https://player.example.com/play/abc123xyz",
                    resolution: "720p",
                    languages: [{ code: "hi", large: "Hindi" }, { code: "en", large: "English" }]
                  }
                ],
                encodes: []
              }
            }
          };
        </script>
      </body>
    </html>
  `;
  const ctx = createMockContext({
    "archive.toonworld4all.me/episode/test-ep": episodeHtml,
  });
  const streamMod = loadModule("stream");
  const streams = await streamMod.getStream({
    link: "https://archive.toonworld4all.me/episode/test-ep",
    type: "series",
    providerContext: ctx,
    isDownload: false,
  });

  assert.equal(streams.length, 1);
  assert.equal(streams[0].server, "ToonWorld Player");
  assert.equal(streams[0].link, "https://player.example.com/play/abc123xyz");
  assert.equal(streams[0].type, "embed");
  assert.equal(streams[0].quality, "720");
  assert.ok(streams[0].headers);
  assert.equal(streams[0].headers.Referer, "https://archive.toonworld4all.me/");
});

test("stream.ts resolves encodes redirect and delegates to hubcloudExtractor", async () => {
  const episodeHtml = `
    <!DOCTYPE html>
    <html>
      <head><title>Episode</title></head>
      <body>
        <script>
          window.__PROPS__ = {
            data: {
              data: {
                streams: [],
                encodes: [
                  {
                    resolution: "1080p",
                    readable: { codec: "1080p x264", size: "450 MB" },
                    files: [
                      {
                        host: "HubCloud",
                        link: "/redirect/hash-hubcloud-1080",
                        short: "hubcloud.link"
                      }
                    ]
                  }
                ]
              }
            }
          };
        </script>
      </body>
    </html>
  `;
  const redirectHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <script>
          window.__PAGE__ = "redirect";
          window.__PROPS__ = {
            link: {
              domain: "https://hubcloud.example.com/drive/",
              hidden: "secret-file-token"
            }
          };
        </script>
      </body>
    </html>
  `;
  const ctx = createMockContext({
    "archive.toonworld4all.me/episode/naruto-1": episodeHtml,
    "/redirect/hash-hubcloud-1080": redirectHtml,
  });

  const streamMod = loadModule("stream");
  const streams = await streamMod.getStream({
    link: "https://archive.toonworld4all.me/episode/naruto-1",
    type: "series",
    providerContext: ctx,
    isDownload: true,
  });

  assert.equal(streams.length, 1);
  assert.equal(streams[0].server, "CF Storage");
  assert.equal(streams[0].link, "https://cf.example.com/file.mkv");
  assert.equal(streams[0].type, "mkv");
  assert.equal(streams[0].quality, "720");
  assert.equal(streams[0].tag, "1080p x264");
});

test("stream.ts resolves GDFlix encodes when available", async () => {
  const episodeHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <script>
          window.__PROPS__ = {
            data: {
              data: {
                streams: [],
                encodes: [
                  {
                    resolution: "720p",
                    readable: { codec: "720p HEVC" },
                    files: [
                      {
                        host: "GDFlix",
                        link: "/redirect/hash-gdflix",
                        short: "gdflix.dev"
                      }
                    ]
                  }
                ]
              }
            }
          };
        </script>
      </body>
    </html>
  `;
  const redirectHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <script>
          window.__PROPS__ = {
            link: {
              domain: "https://gdflix.example.com/file/",
              hidden: "gdflix-token-123"
            }
          };
        </script>
      </body>
    </html>
  `;
  const ctx = createMockContext({
    "archive.toonworld4all.me/episode/ep-gd": episodeHtml,
    "/redirect/hash-gdflix": redirectHtml,
  });

  const streamMod = loadModule("stream");
  const streams = await streamMod.getStream({
    link: "https://archive.toonworld4all.me/episode/ep-gd",
    type: "series",
    providerContext: ctx,
    isDownload: false,
  });

  assert.equal(streams.length, 1);
  assert.equal(streams[0].server, "ResumeCloud");
  assert.equal(streams[0].link, "https://gdflix.example.com/download.mkv");
  assert.equal(streams[0].quality, "720");
});

test("stream.ts prioritizes download servers when isDownload is true and web player when false", async () => {
  const episodeHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <script>
          window.__PROPS__ = {
            data: {
              data: {
                streams: [
                  {
                    play: "https://player.example.com/play/direct",
                    resolution: "1080p"
                  }
                ],
                encodes: [
                  {
                    resolution: "1080p",
                    files: [
                      {
                        host: "HubCloud",
                        link: "/redirect/hub-ok"
                      }
                    ]
                  }
                ]
              }
            }
          };
        </script>
      </body>
    </html>
  `;
  const redirectHtml = `
    <script>
      window.__PROPS__ = {
        link: { domain: "https://hubcloud.example.com/drive/", hidden: "token" }
      };
    </script>
  `;
  const ctx = createMockContext({
    "archive.toonworld4all.me/episode/ep-both": episodeHtml,
    "/redirect/hub-ok": redirectHtml,
  });

  const streamMod = loadModule("stream");

  // When isDownload is true, CF Storage download server should come first
  const dlStreams = await streamMod.getStream({
    link: "https://archive.toonworld4all.me/episode/ep-both",
    type: "series",
    providerContext: ctx,
    isDownload: true,
  });
  assert.equal(dlStreams[0].server, "CF Storage");

  // When isDownload is false, ToonWorld Player embed should come first
  const playStreams = await streamMod.getStream({
    link: "https://archive.toonworld4all.me/episode/ep-both",
    type: "series",
    providerContext: ctx,
    isDownload: false,
  });
  assert.equal(playStreams[0].server, "ToonWorld Player");
});

test("stream.ts handles upstream errors gracefully without throwing unhandled exceptions", async () => {
  const episodeHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <script>
          window.__PROPS__ = {
            data: {
              data: {
                streams: [],
                encodes: [
                  {
                    resolution: "480p",
                    files: [
                      {
                        host: "HubCloud",
                        link: "/redirect/broken-hub"
                      }
                    ]
                  }
                ]
              }
            }
          };
        </script>
      </body>
    </html>
  `;
  const redirectHtml = `
    <script>
      window.__PROPS__ = {
        link: { domain: "https://broken.example.com/drive/", hidden: "broken" }
      };
    </script>
  `;
  const ctx = createMockContext({
    "archive.toonworld4all.me/episode/ep-broken": episodeHtml,
    "/redirect/broken-hub": redirectHtml,
  });

  const streamMod = loadModule("stream");
  const streams = await streamMod.getStream({
    link: "https://archive.toonworld4all.me/episode/ep-broken",
    type: "series",
    providerContext: ctx,
    isDownload: false,
  });

  assert.deepEqual(streams, []);
});
