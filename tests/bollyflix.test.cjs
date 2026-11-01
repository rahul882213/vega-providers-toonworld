const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const cheerio = require("cheerio");
const axios = require("axios");

function loadModule(name) {
  const filePath = path.resolve(__dirname, `../dist/bollyflix/${name}.js`);
  delete require.cache[filePath];
  return require(filePath);
}

function createMockContext(mockRoutes = {}) {
  return {
    cheerio,
    commonHeaders: {
      "User-Agent": "MockBrowser/1.0",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    },
    axios: {
      get: async (url, config = {}) => {
        for (const [key, response] of Object.entries(mockRoutes)) {
          if (url.includes(key)) {
            if (typeof response === "function") {
              return response("GET", url, config);
            }
            return {
              status: 200,
              data: response,
              headers: { "set-cookie": ["PHPSESSID=mock_session_123; path=/"] },
              request: { res: { responseUrl: url } },
            };
          }
        }
        return {
          status: 200,
          data: "<html><body><article><header><h2 class='title'><a href='https://bollyflix.church/movie-1/'>Download Test Movie (2024) 720p</a></h2></header><div class='featured-thumbnail'><img src='https://img.test/1.jpg' /></div></article></body></html>",
          headers: {},
          request: { res: { responseUrl: url } },
        };
      },
      post: async (url, data, config = {}) => {
        for (const [key, response] of Object.entries(mockRoutes)) {
          if (url.includes(key)) {
            if (typeof response === "function") {
              return response("POST", url, config, data);
            }
            return {
              status: 200,
              data: response,
              headers: {},
              request: { res: { responseUrl: url } },
            };
          }
        }
        return { status: 200, data: "<html><body></body></html>" };
      },
    },
    kvStore: {
      get: async (key) => null,
      set: async (key, val) => {},
    },
  };
}

test("catalog.ts exports catalog and genres arrays", () => {
  const catalogMod = loadModule("catalog");
  assert.ok(Array.isArray(catalogMod.catalog), "catalog should be an array");
  assert.ok(catalogMod.catalog.length > 5, "catalog should contain categories");
  assert.equal(catalogMod.catalog[0].title, "Latest");

  assert.ok(Array.isArray(catalogMod.genres), "genres should be an array");
  assert.ok(catalogMod.genres.length > 0, "genres should contain genres");
});

test("posts.ts getPosts and getSearchPosts scrape articles properly", async () => {
  const mockHtml = `
    <html>
      <body>
        <article>
          <header>
            <h2 class="title front-view-title">
              <a href="https://bollyflix.church/sample-movie-2024/">Download Sample Movie (2024) Dual Audio 720p WEB-DL</a>
            </h2>
          </header>
          <div class="featured-thumbnail">
            <img src="https://img.test/thumb.jpg" alt="Sample Movie" />
          </div>
        </article>
      </body>
    </html>
  `;

  const ctx = createMockContext({
    "bollyflix.church": mockHtml,
  });

  const postsMod = loadModule("posts");

  const posts = await postsMod.getPosts({
    filter: "/bollywood-movies/",
    page: 1,
    signal: new AbortController().signal,
    providerContext: ctx,
  });

  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, "Sample Movie (2024) Dual Audio 720p WEB-DL");
  assert.equal(posts[0].link, "https://bollyflix.church/sample-movie-2024/");
  assert.equal(posts[0].image, "https://img.test/thumb.jpg");
  assert.equal(posts[0].tag, "720P");

  const searchPosts = await postsMod.getSearchPosts({
    searchQuery: "Sample",
    page: 1,
    signal: new AbortController().signal,
    providerContext: ctx,
  });

  assert.equal(searchPosts.length, 1);
  assert.equal(searchPosts[0].title, "Sample Movie (2024) Dual Audio 720p WEB-DL");
});

test("meta.ts extracts movie metadata and groups download links", async () => {
  const mockMovieHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Download Jailer (2023) Dual Audio 480p | 720p | 1080p</title>
        <meta property="og:description" content="A retired jailer goes on a manhunt to find his son's killers." />
        <meta property="og:image" content="https://img.test/poster.jpg" />
      </head>
      <body>
        <h1>Download Jailer (2023) Dual Audio {Hindi-Tamil} Movie 480p | 720p | 1080p</h1>
        <p>IMDb Rating: 7.1/10 (tt11663228)</p>
        <p>Storyline: A retired police warden takes matters into his own hands.</p>

        <p>Jailer (2023) {Hindi-Tamil} 480p [550MB]</p>
        <p>
          <a class="dl" href="https://dl.fastdlserver.site/?id=fastdl_480">🚀 Google Drive</a>
          <a class="dl" href="https://linksmod.top/view/linksmod_480">🔗 Download Links</a>
        </p>

        <p>Jailer (2023) {Hindi-Tamil} 720p [1.4GB]</p>
        <p>
          <a class="dl" href="https://dl.fastdlserver.site/?id=fastdl_720">🚀 Google Drive</a>
          <a class="dl" href="https://linksmod.top/view/linksmod_720">🔗 Download Links</a>
        </p>
      </body>
    </html>
  `;

  const ctx = createMockContext({
    "jailer-2023": mockMovieHtml,
    "v3-cinemeta.strem.io": {
      meta: {
        name: "Jailer",
        imdb_id: "tt11663228",
        type: "movie",
        description: "Enriched description from Cinemeta",
        poster: "https://img.test/cinemeta-poster.jpg",
      },
    },
  });

  const metaMod = loadModule("meta");
  const info = await metaMod.getMeta({
    link: "https://bollyflix.church/jailer-2023/",
    providerContext: ctx,
  });

  assert.equal(info.type, "movie");
  assert.equal(info.imdbId, "tt11663228");
  assert.equal(info.title, "Jailer");
  assert.ok(info.linkList.length >= 2, "should group 480p and 720p");
  assert.equal(info.linkList[0].directLinks.length, 2);
  assert.equal(info.linkList[0].directLinks[0].title, "Google Drive (Fast Server)");
  assert.equal(info.linkList[0].directLinks[1].title, "Multi Links (LinksMod)");
});

test("meta.ts extracts series metadata and episodesLink", async () => {
  const mockSeriesHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Download Line of Fire (Season 1) English WEB Series 720p</title>
      </head>
      <body>
        <h1>Download Line of Fire (Season 1) English WEB Series 720p | 1080p</h1>
        <p>Synopsis: Criminal investigations in the line of duty.</p>

        <p>Line of Fire (Season 1) English 720p [350MB/E]</p>
        <p>
          <a class="maxbutton maxbutton-download-links" href="https://fxlinks.rest/elinks/dex87798/">Download Links</a>
        </p>
      </body>
    </html>
  `;

  const ctx = createMockContext({
    "line-of-fire": mockSeriesHtml,
  });

  const metaMod = loadModule("meta");
  const info = await metaMod.getMeta({
    link: "https://bollyflix.church/line-of-fire/",
    providerContext: ctx,
  });

  assert.equal(info.type, "series");
  assert.ok(info.linkList.length >= 1);
  assert.equal(info.linkList[0].episodesLink, "https://fxlinks.rest/elinks/dex87798/");
});

test("episodes.ts extracts episode items from fxlinks", async () => {
  const mockFxHtml = `
    <!DOCTYPE html>
    <html>
      <body>
        <div id="content">
          <a href="https://dl.fastdlserver.site/?id=ep1">Episode 01</a>
          <a href="https://dl.fastdlserver.site/?id=ep2">Episode 02</a>
          <a href="https://dl.fastdlserver.site/?id=ep3">Episode 03</a>
        </div>
      </body>
    </html>
  `;

  const ctx = createMockContext({
    "fxlinks.rest/elinks": mockFxHtml,
  });

  const epMod = loadModule("episodes");
  const episodes = await epMod.getEpisodes({
    url: "https://fxlinks.rest/elinks/dex87798/",
    providerContext: ctx,
  });

  assert.equal(episodes.length, 3);
  assert.equal(episodes[0].title, "Episode 01");
  assert.equal(episodes[0].link, "https://dl.fastdlserver.site/?id=ep1");
  assert.equal(episodes[1].title, "Episode 02");
});

test("stream.ts unlocks linksmod.top and returns multiple locker streams", async () => {
  const lockedHtml = `
    <html>
      <body>
        <form method="post" action="">
          <input type="hidden" name="_csrf_token_test" value="token_val_123" />
          <button type="submit">Unlock</button>
        </form>
      </body>
    </html>
  `;

  const unlockedHtml = `
    <html>
      <body>
        <a href="https://fromsmash.com/abc">FromSmash</a>
        <a href="https://dgdrive.xyz/def">DGDrive</a>
        <a href="https://multiup.org/download/ghi/video.mkv">MultiUp</a>
      </body>
    </html>
  `;

  const ctx = createMockContext({
    "linksmod.top/view/test-token": (method) => {
      if (method === "GET") {
        return {
          status: 200,
          data: lockedHtml,
          headers: { "set-cookie": ["PHPSESSID=session_456; path=/"] },
        };
      }
      return {
        status: 200,
        data: unlockedHtml,
        headers: {},
      };
    },
  });

  const streamMod = loadModule("stream");
  const streams = await streamMod.getStream({
    link: "https://linksmod.top/view/test-token",
    type: "movie",
    providerContext: ctx,
    isDownload: true,
  });

  assert.ok(streams.length >= 3, "should extract unlocked locker links");
  const servers = streams.map((s) => s.server);
  assert.ok(servers.includes("FromSmash"), "should include FromSmash");
  assert.ok(servers.includes("DGDrive"), "should include DGDrive");
  assert.ok(servers.includes("MultiUp"), "should include MultiUp");
});

test("stream.ts handles fastdlserver links gracefully", async () => {
  const ctx = createMockContext({});

  const streamMod = loadModule("stream");
  const streams = await streamMod.getStream({
    link: "https://dl.fastdlserver.site/?id=token123&type=file",
    type: "movie",
    providerContext: ctx,
    isDownload: false,
  });

  assert.ok(streams.length > 0);
  assert.equal(streams[0].server, "FastDL (Google Drive)");
});

test("settings.ts exports getSettingsSchema", async () => {
  const settingsMod = loadModule("settings");
  const schema = await settingsMod.getSettingsSchema({
    providerContext: createMockContext(),
  });

  assert.ok(Array.isArray(schema));
  assert.ok(schema.some((f) => f.key === "baseUrlOverride"));
  assert.ok(schema.some((f) => f.key === "preferredQuality"));
});
