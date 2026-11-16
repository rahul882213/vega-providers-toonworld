const assert = require("node:assert/strict");
const { test } = require("node:test");
const cheerio = require("cheerio");
const { buildSync } = require("esbuild");
const path = require("node:path");

const rootDir = path.join(__dirname, "..");

function loadTs(relPath) {
  const code = buildSync({
    entryPoints: [path.join(rootDir, relPath)],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
  }).outputFiles[0].text;
  const mod = { exports: {} };
  new Function("exports", "require", "module", code)(mod.exports, require, mod);
  return mod.exports;
}

test("getBaseUrl returns verified domains for 1cinevood, w4u, and lux", async () => {
  const { getBaseUrl } = loadTs("providers/getBaseUrl.ts");
  assert.equal(await getBaseUrl("1cinevood"), "https://one.1cinevood.baby");
  assert.equal(await getBaseUrl("w4u"), "https://world4ufree.co.in");
  assert.equal(await getBaseUrl("lux"), "https://rogmovies.digital");
});

test("1Cinewood search, pagination, and mfx metadata extraction", async () => {
  const { getSearchPosts } = loadTs("providers/1cinevood/posts.ts");
  const { getMeta } = loadTs("providers/1cinevood/meta.ts");

  const requestedUrls = [];
  const mockContext = {
    cheerio,
    commonHeaders: { "User-Agent": "Mozilla/5.0" },
    kvStore: { get: async () => false },
    axios: {
      get: async (url) => {
        requestedUrls.push(url);
        if (url.includes("?s=Jailer")) {
          return {
            status: 200,
            data: `
              <article class="latestPost excerpt">
                <a href="https://one.1cinevood.baby/download-jailer-2-2026/" id="featured-thumbnail">
                  <img src="https://one.1cinevood.baby/poster.webp" />
                </a>
                <header class="entry-header">
                  <h1 class="entry-title"><a href="https://one.1cinevood.baby/download-jailer-2-2026/">Download Jailer 2 (2026) 1080p WEB-DL</a></h1>
                </header>
              </article>
            `,
          };
        }
        return {
          status: 200,
          data: `
            <div class="entry-content">
              <h2 class="mfx-main-title">Download Jailer 2 (2026)</h2>
              <div class="mfx-info-box">Movie Name: Jailer 2 Release Year: 2026</div>
              <div class="mfx-imdb"><a href="https://www.imdb.com/title/tt33318732/">IMDb</a></div>
              <div class="mfx-plot-box">A retired officer returns.</div>
              <div class="mfx-download-group">
                <h3 class="mfx-quality-title">Jailer 2 (2026) [Hindi + Tamil] WeB-DL 1080p x264 [3.7GB]</h3>
                <div class="mfx-download-buttons">
                  <a class="mfx-download-link" href="https://mobilejsr.best/genxfm784776519171/">Download Now</a>
                </div>
              </div>
            </div>
          `,
        };
      },
    },
  };

  const results = await getSearchPosts({
    searchQuery: "Jailer",
    page: 2,
    providerContext: mockContext,
  });
  assert.ok(
    requestedUrls[0].startsWith("https://one.1cinevood.baby/page/2/?s=Jailer"),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Jailer 2 (2026)");

  const meta = await getMeta({
    link: results[0].link,
    providerContext: mockContext,
  });
  assert.equal(meta.title, "Jailer 2");
  assert.equal(meta.imdbId, "tt33318732");
  assert.equal(meta.linkList.length, 1);
  assert.equal(meta.linkList[0].quality, "1080p");
});

test("World4uFree Zetaflix search, metadata, and episode extraction", async () => {
  const { getSearchPosts } = loadTs("providers/world4u/posts.ts");
  const { getMeta } = loadTs("providers/world4u/meta.ts");
  const { getEpisodes } = loadTs("providers/world4u/episodes.ts");

  const requestedUrls = [];
  const mockContext = {
    cheerio,
    commonHeaders: { "User-Agent": "Mozilla/5.0" },
    axios: {
      get: async (url) => {
        requestedUrls.push(url);
        if (url.includes("?s=")) {
          return {
            status: 200,
            data: `
              <div class="item-box">
                <a href="https://world4ufree.co.in/tvshows/secret-stories-roslin/" title="Secret Stories: Roslin">
                  <img data-original="https://world4ufree.co.in/wp-content/uploads/2026/02/pgVtjCdC5aBADQswOGx7BnTbjgH.jpg" />
                </a>
              </div>
            `,
          };
        }
        if (url.includes("wecollege.net") || url.includes("cinemeta")) {
          return { status: 200, data: { results: [] } };
        }
        return {
          status: 200,
          data: `
            <div class="details-title"><h3>Secret Stories: Roslin</h3></div>
            <div class="content-poster"><img src="https://image.tmdb.org/t/p/w500/pgVtjCdC5aBADQswOGx7BnTbjgH.jpg" /></div>
            <div class="details-desc"><p>A 17-year-old girl is plagued by nightmares.</p></div>
            <ul id="season-listep-1" class="episodes-list">
              <li>
                <a href="https://world4ufree.co.in/episodes/secret-stories-roslin-1x1/">
                  <span class="ep-num">1</span>
                  <span class="ep-title">Rose Valley</span>
                </a>
              </li>
            </ul>
          `,
        };
      },
    },
  };

  const results = await getSearchPosts({
    searchQuery: "Secret Stories Roslin",
    page: 1,
    providerValue: "world4u",
    signal: new AbortController().signal,
    providerContext: mockContext,
  });
  assert.ok(
    requestedUrls[0].startsWith(
      "https://world4ufree.co.in/?s=Secret%20Stories%20Roslin",
    ),
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Secret Stories: Roslin");

  const meta = await getMeta({
    link: results[0].link,
    providerContext: mockContext,
  });
  assert.equal(meta.type, "series");
  assert.equal(meta.linkList.length, 1);

  const episodes = await getEpisodes({
    url: meta.linkList[0].episodesLink,
    providerContext: mockContext,
  });
  assert.equal(episodes.length, 1);
  assert.equal(episodes[0].title, "Episode 01 - Rose Valley");
});

test("RogMovies (luxMovies) uses https://rogmovies.digital and handles 403 via WAF solver or graceful fallback", async () => {
  const { getSearchPosts } = loadTs("providers/luxMovies/posts.ts");

  const requestedUrls = [];
  let wafCalled = false;
  const mockContextWithWaf = {
    cheerio,
    commonHeaders: { "User-Agent": "Mozilla/5.0" },
    kvStore: { get: async () => null, set: async () => {} },
    openWebView: async (url) => {
      wafCalled = true;
      return {
        cookies: "cf_clearance=valid_token; xla=s4t",
        userAgent: "Mozilla/5.0",
        data: JSON.stringify({
          hits: [
            {
              document: {
                post_title: "Download Secret Invasion (2023)",
                permalink: "/download-secret-invasion-2023/",
                post_thumbnail: "https://rogmovies.digital/poster.jpg",
                imdbRating: "7.2",
              },
            },
          ],
        }),
      };
    },
    axios: {
      get: async (url) => {
        requestedUrls.push(url);
        const err = new Error("Forbidden");
        err.response = { status: 403 };
        throw err;
      },
    },
  };

  const results = await getSearchPosts({
    searchQuery: "Secret",
    page: 1,
    providerValue: "luxMovies",
    signal: new AbortController().signal,
    providerContext: mockContextWithWaf,
  });
  assert.ok(
    requestedUrls[0].startsWith(
      "https://rogmovies.digital/search.php?q=Secret&page=1",
    ),
  );
  assert.equal(wafCalled, true);
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Secret Invasion (2023)");
});
