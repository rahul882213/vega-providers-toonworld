import { Post, ProviderContext } from "../types";
import { getBaseUrl } from "../getBaseUrl";
import { throwProviderError } from "../providerErrors";

const DEFAULT_ROGMOVIES_BASE_URL = "https://rogmovies.digital";
const UNBLOCKED_ROG_MIRRORS = [
  "https://zeefliz1.xyz",
  "https://one.1cinevood.baby",
];

const defaultHeaders: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "sec-ch-ua":
    '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  Cookie: "xla=s4t",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const wafSessionCache = new Map<
  string,
  { cookies?: string; userAgent?: string }
>();

export function normalizeRogLockerUrl(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
  let normalized = rawUrl.trim().replace(
    /^https?:\/\/(?:www\.)?mobilejsr\.(?:best|com|org|net|xyz|top|live|in)\//i,
    "https://nexdrive.store/",
  );
  // Collapse accidental double slashes in path (e.g. https://nexdrive.store/genxfm...//)
  normalized = normalized.replace(/^(https?:\/\/[^/#?]+)(.*)$/i, (_, origin, rest) => {
    return origin + rest.replace(/\/{2,}/g, "/");
  });
  return normalized;
}

export function cleanPosterUrl(raw: string | undefined, baseUrl: string): string {
  if (!raw) return "";
  const val = raw.trim();
  if (!val || val.startsWith("data:")) return "";
  if (val.startsWith("//")) return `https:${val}`;
  if (val.startsWith("/")) return `${baseUrl.replace(/\/+$/, "")}${val}`;
  return val;
}

export async function getRogMoviesBaseUrl(): Promise<string> {
  try {
    const raw = await getBaseUrl("lux");
    if (!raw || /(?:rogmovies\.cyou|roamovies\.cyou)/i.test(raw)) {
      return DEFAULT_ROGMOVIES_BASE_URL;
    }
    return raw.replace(/\/+$/, "");
  } catch {
    return DEFAULT_ROGMOVIES_BASE_URL;
  }
}

export function isWafChallenge(html: string): boolean {
  if (!html || typeof html !== "string") return false;
  return (
    html.includes("<title>Just a moment...</title>") ||
    html.includes("challenges.cloudflare.com") ||
    html.includes("cf-mitigated") ||
    html.includes("cf-chl-widget") ||
    html.includes("Attention Required! | Cloudflare") ||
    (html.includes("Cloudflare Ray ID") && html.includes("Please wait"))
  );
}

async function tryFetchFromUnblockedMirrors(
  rawUrl: string,
  axios: any,
  reqHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ data: any; status: number; resolvedUrl: string } | null> {
  try {
    const u = new URL(rawUrl);
    if (!/rogmovies|roamovies|vegamovies|zeefliz/i.test(u.hostname)) {
      return null;
    }

    for (const mirror of UNBLOCKED_ROG_MIRRORS) {
      if (mirror.includes(u.hostname)) continue;
      try {
        let targetPath = u.pathname + u.search;
        if (u.pathname === "/search.php") {
          const q = u.searchParams.get("q") || "";
          const p = Number(u.searchParams.get("page") || "1");
          targetPath =
            p > 1
              ? `/page/${p}/?s=${encodeURIComponent(q)}`
              : `/?s=${encodeURIComponent(q)}`;
        }
        const candidatePaths = [targetPath];
        if (!targetPath.startsWith("/category/") && targetPath !== "/" && !targetPath.includes("?s=") && !targetPath.startsWith("/page/")) {
          candidatePaths.push(`/category${targetPath}`);
        }
        for (const p of candidatePaths) {
          try {
            const mirrorUrl = `${mirror}${p}`;
            const mRes = await axios.get(mirrorUrl, {
              headers: { ...reqHeaders, Referer: `${mirror}/` },
              signal,
              timeout: 10000,
            });
            if (
              mRes?.data &&
              (typeof mRes.data !== "string" || !isWafChallenge(mRes.data))
            ) {
              return { data: mRes.data, status: mRes.status || 200, resolvedUrl: mirrorUrl };
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}
  return null;
}

export async function fetchRogWithWAF(
  rawUrl: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<{ data: any; status: number; resolvedUrl?: string }> {
  const url = normalizeRogLockerUrl(rawUrl);
  const { axios, commonHeaders, openWebView, kvStore } = providerContext;
  const origin = url.split("/").slice(0, 3).join("/");
  let cached = wafSessionCache.get(origin);

  if (!cached && kvStore) {
    try {
      const savedCookies = await kvStore.get<string>("luxMovies_cf_cookies");
      const savedUa = await kvStore.get<string>("luxMovies_cf_ua");
      if (savedCookies) {
        cached = { cookies: savedCookies, userAgent: savedUa || undefined };
        wafSessionCache.set(origin, cached);
      }
    } catch {}
  }

  const reqHeaders: Record<string, string> = {
    ...defaultHeaders,
    ...commonHeaders,
    Referer: `${origin}/`,
    ...extraHeaders,
  };

  if (cached?.userAgent) {
    reqHeaders["User-Agent"] = cached.userAgent;
  }
  if (cached?.cookies) {
    reqHeaders["Cookie"] = cached.cookies.includes("xla=s4t")
      ? cached.cookies
      : `xla=s4t; ${cached.cookies}`;
  }

  try {
    const res = await axios.get(url, {
      headers: reqHeaders,
      signal,
    });
    if (
      typeof res.data === "string" &&
      isWafChallenge(res.data)
    ) {
      throw { response: { status: 403 } };
    }
    return { data: res.data, status: res.status || 200, resolvedUrl: url };
  } catch (error: any) {
    // 1. Before opening WebView, try unblocked RogMovies sister mirrors (zeefliz1.xyz / one.1cinevood.baby)
    const mirrorResult = await tryFetchFromUnblockedMirrors(
      url,
      axios,
      reqHeaders,
      signal,
    );
    if (mirrorResult) {
      return mirrorResult;
    }

    // 2. If it is a genxfm URL, try nexdrive.store
    if (url.includes("/genxfm") && !url.includes("nexdrive.store")) {
      try {
        const nexUrl = url.replace(/^https?:\/\/[^/]+\//i, "https://nexdrive.store/");
        const nexRes = await axios.get(nexUrl, {
          headers: { ...reqHeaders, Referer: "https://nexdrive.store/" },
          signal,
        });
        if (typeof nexRes?.data === "string" && !isWafChallenge(nexRes.data)) {
          return { data: nexRes.data, status: nexRes.status || 200, resolvedUrl: nexUrl };
        }
      } catch {}
    }

    const status = error?.response?.status;
    if ((status === 403 || status === 503) && typeof openWebView === "function") {
      try {
        const cleanHeaders = { ...reqHeaders };
        delete cleanHeaders["Cookie"];
        const wafResult = await openWebView(url, {
          title: "Solve the captcha below and click done",
          description: "Required to access RogMovies.",
          headers: cleanHeaders,
          waitForCookie: "cf_clearance",
          force: true,
        });

        const solvedCookies = wafResult?.cookies;
        const solvedUa = wafResult?.userAgent || reqHeaders["User-Agent"];

        if (solvedCookies) {
          const fullCookies = solvedCookies.includes("xla=s4t")
            ? solvedCookies
            : `xla=s4t; ${solvedCookies}`;
          wafSessionCache.set(origin, {
            cookies: fullCookies,
            userAgent: solvedUa,
          });
          try {
            await kvStore?.set("luxMovies_cf_cookies", fullCookies);
            if (solvedUa) await kvStore?.set("luxMovies_cf_ua", solvedUa);
          } catch {}
        }

        if (
          wafResult?.data &&
          !isWafChallenge(wafResult.data) &&
          wafResult.data.trim().length > 20
        ) {
          let parsedData: any = wafResult.data;
          if (
            typeof parsedData === "string" &&
            (parsedData.trim().startsWith("{") ||
              parsedData.trim().startsWith("["))
          ) {
            try {
              parsedData = JSON.parse(parsedData);
            } catch {}
          }
          return { data: parsedData, status: 200, resolvedUrl: wafResult.url || url };
        }

        const retryHeaders: Record<string, string> = {
          ...reqHeaders,
          "User-Agent": solvedUa,
          ...(solvedCookies
            ? {
                Cookie: solvedCookies.includes("xla=s4t")
                  ? solvedCookies
                  : `xla=s4t; ${solvedCookies}`,
              }
            : {}),
        };

        const retryRes = await axios.get(wafResult?.url || url, {
          headers: retryHeaders,
          signal,
        });
        return { data: retryRes.data, status: retryRes.status || 200, resolvedUrl: wafResult?.url || url };
      } catch (wafErr) {
        console.warn("RogMovies openWebView WAF solver failed:", wafErr);
      }
    }
    throw error;
  }
}

export function parsePostsFromHtml(
  $: any,
  baseUrl: string,
): Post[] {
  const posts: Post[] = [];
  const seen = new Set<string>();

  const extractImg = (root: any): string => {
    const imgs = root.find("img");
    for (let i = 0; i < imgs.length; i++) {
      const img = $(imgs[i]);
      const candidates = [
        img.attr("data-lazy-src"),
        img.attr("data-src"),
        img.attr("data-original"),
        img.attr("src"),
      ];
      for (const c of candidates) {
        const cleaned = cleanPosterUrl(c, baseUrl);
        if (cleaned) return cleaned;
      }
    }
    return "";
  };

  $(".blog-items,.post-list,#archive-container,.movies-grid")
    ?.children("article,.entry-list-item,a")
    ?.each((_: number, element: any) => {
      const href =
        $(element)?.find("a")?.attr("href") || $(element)?.attr("href") || "";
      if (!href) return;

      const postUrl = new URL(href, `${baseUrl}/`);
      const link = `${postUrl.pathname}${postUrl.search}${postUrl.hash}`;
      if (!link || link === "/" || seen.has(link)) return;

      const rating =
        $(element)
          .find(".imdb-score, .rating, [class*='score']")
          .text()
          .match(/(\d+(?:\.\d+)?)/)?.[1] ||
        $(element).find('meta[itemprop="ratingValue"]').attr("content")?.trim();
      const tag = rating ? `${rating}★` : undefined;

      const title = (
        $(element)
          ?.find(".entry-title,.poster-title,h2,h1")
          ?.text()
          ?.replace(/^Download\s+/i, "")
          ?.match(/^(.*?)\s*\((\d{4})\)|^(.*?)\s*\((Season \d+)\)/)?.[0] ||
        $(element)
          ?.find("a")
          ?.attr("title")
          ?.replace(/^Download\s+/i, "") ||
        $(element)
          ?.find(".post-title,.poster-title,.entry-title,h2,h1")
          .text()
          ?.replace(/^Download\s+/i, "") ||
        ""
      ).trim();

      const image = extractImg($(element));

      if (title) {
        seen.add(link);
        posts.push({ title, link, image, tag });
      }
    });

  if (posts.length === 0) {
    $("article").each((_: number, element: any) => {
      const card = $(element);
      const href = card.find("a[href]").first().attr("href") || "";
      if (!href) return;

      const postUrl = new URL(href, `${baseUrl}/`);
      const link = `${postUrl.pathname}${postUrl.search}${postUrl.hash}`;
      if (!link || link === "/" || seen.has(link)) return;

      const rawTitle =
        card
          .find(".entry-title, .post-title, h1, h2, h3")
          .first()
          .text()
          .trim() ||
        card.find("a[title]").first().attr("title")?.trim() ||
        "";
      const title = rawTitle
        .replace(/^Download\s+/i, "")
        .replace(/\s{2,}/g, " ")
        .trim();

      const image = extractImg(card);

      if (title) {
        seen.add(link);
        posts.push({ title, link, image });
      }
    });
  }

  return posts;
}

export const getPosts = async ({
  filter,
  page = 1,
  providerValue,
  signal,
  providerContext,
}: {
  filter: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> => {
  const baseUrl = await getRogMoviesBaseUrl();
  const cleanFilter = (filter || "").trim().replace(/^\/+|\/+$/g, "");
  const url = cleanFilter
    ? page > 1
      ? `${baseUrl}/${cleanFilter}/page/${page}/`
      : `${baseUrl}/${cleanFilter}/`
    : page > 1
      ? `${baseUrl}/page/${page}/`
      : `${baseUrl}/`;
  const result = await posts(baseUrl, url, signal, providerContext);
  if (result.length === 0 && cleanFilter && !cleanFilter.startsWith("category/")) {
    const catUrl =
      page > 1
        ? `${baseUrl}/category/${cleanFilter}/page/${page}/`
        : `${baseUrl}/category/${cleanFilter}/`;
    return posts(baseUrl, catUrl, signal, providerContext);
  }
  return result;
};

export const getSearchPosts = async ({
  searchQuery,
  page = 1,
  providerValue,
  signal,
  providerContext,
}: {
  searchQuery: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> => {
  const { cheerio } = providerContext;
  const baseUrl = await getRogMoviesBaseUrl();
  const cleanQuery = (searchQuery || "").trim();
  if (!cleanQuery) return [];

  const encodedQuery = encodeURIComponent(cleanQuery);
  const searchPhpUrl = `${baseUrl}/search.php?q=${encodedQuery}&page=${page}`;

  const mapHitsToPosts = (hits: any[]): Post[] => {
    const result: Post[] = [];
    for (const hit of hits) {
      const doc = hit?.document || hit;
      if (!doc?.post_title && !doc?.title) continue;
      const permalink = doc.permalink || doc.link || "";
      if (!permalink) continue;
      const postUrl = new URL(permalink, `${baseUrl}/`);
      const docRating = doc.rating || doc.imdbRating || doc.imdb_rating;
      const tag = docRating ? `${docRating}★` : undefined;
      result.push({
        title: String(doc.post_title || doc.title)
          .replace(/^Download\s+/i, "")
          .trim(),
        link: `${postUrl.pathname}${postUrl.search}${postUrl.hash}`,
        image: cleanPosterUrl(doc.post_thumbnail || doc.image || "", baseUrl),
        tag,
      });
    }
    return result;
  };

  try {
    const response = await fetchRogWithWAF(
      searchPhpUrl,
      providerContext,
      signal,
    );
    let data = response.data;
    if (typeof data === "string" && data.trim().startsWith("{")) {
      try {
        data = JSON.parse(data);
      } catch {}
    }

    if (data?.hits && Array.isArray(data.hits)) {
      const hitPosts = mapHitsToPosts(data.hits);
      if (hitPosts.length > 0) return hitPosts;
    }

    if (typeof data === "string" && data.includes("<")) {
      const $ = cheerio.load(data);
      const htmlPosts = parsePostsFromHtml($, baseUrl);
      if (htmlPosts.length > 0) return htmlPosts;
    }
  } catch {}

  try {
    const wpSearchUrl =
      page > 1
        ? `${baseUrl}/page/${page}/?s=${encodedQuery}`
        : `${baseUrl}/?s=${encodedQuery}`;
    const wpRes = await fetchRogWithWAF(wpSearchUrl, providerContext, signal);
    if (typeof wpRes.data === "string") {
      const $ = cheerio.load(wpRes.data);
      const htmlPosts = parsePostsFromHtml($, baseUrl);
      if (htmlPosts.length > 0) return htmlPosts;
    }
  } catch (error: any) {
    if (error?.response?.status === 403 || error?.response?.status === 404) {
      return [];
    }
    throwProviderError("LuxMovies", "search posts", error);
  }

  return [];
};

async function posts(
  baseUrl: string,
  url: string,
  signal: AbortSignal,
  providerContext: ProviderContext,
): Promise<Post[]> {
  const { cheerio } = providerContext;
  try {
    const res = await fetchRogWithWAF(url, providerContext, signal);
    const html = typeof res.data === "string" ? res.data : "";
    const $ = cheerio.load(html);
    return parsePostsFromHtml($, baseUrl);
  } catch (error: any) {
    if (error?.response?.status === 403 || error?.response?.status === 404) {
      return [];
    }
    throwProviderError("LuxMovies", "posts", error);
  }
}
