import { Post, ProviderContext } from "../types";
import { getBaseUrl } from "../getBaseUrl";
import { throwProviderError } from "../providerErrors";

const DEFAULT_ROGMOVIES_BASE_URL = "https://rogmovies.digital";

const defaultHeaders: Record<string, string> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Cache-Control": "no-store",
  "Accept-Language": "en-US,en;q=0.9",
  DNT: "1",
  "sec-ch-ua":
    '"Not_A Brand";v="8", "Chromium";v="131", "Microsoft Edge";v="131"',
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

export async function fetchRogWithWAF(
  url: string,
  providerContext: ProviderContext,
  signal?: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<{ data: any; status: number }> {
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
      isWafChallenge(res.data) && typeof openWebView === "function"
    ) {
      throw { response: { status: 403 } };
    }
    return { data: res.data, status: res.status || 200 };
  } catch (error: any) {
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
          return { data: parsedData, status: 200 };
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
        return { data: retryRes.data, status: retryRes.status || 200 };
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

      let image =
        $(element).find("a").find("img").attr("data-lazy-src") ||
        $(element).find("a").find("img").attr("data-src") ||
        $(element).find("a").find("img").attr("src") ||
        $(element).find("img").attr("data-src") ||
        $(element).find("img").attr("src") ||
        "";
      if (image.startsWith("//")) {
        image = "https:" + image;
      }

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
      let image =
        card.find("img").first().attr("data-lazy-src") ||
        card.find("img").first().attr("data-src") ||
        card.find("img").first().attr("src") ||
        "";
      if (image.startsWith("//")) image = "https:" + image;
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
  console.log("vegaGetPosts baseUrl:", providerValue, baseUrl, "url:", url);
  return posts(baseUrl, url, signal, providerContext);
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
  const { axios, cheerio, commonHeaders } = providerContext;
  const baseUrl = await getRogMoviesBaseUrl();
  const cleanQuery = (searchQuery || "").trim();
  if (!cleanQuery) return [];

  const encodedQuery = encodeURIComponent(cleanQuery);
  const searchPhpUrl = `${baseUrl}/search.php?q=${encodedQuery}&page=${page}`;
  console.log("vegaGetSearchPosts baseUrl:", providerValue, baseUrl, "url:", searchPhpUrl);

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
        image: doc.post_thumbnail || doc.image || "",
        tag,
      });
    }
    return result;
  };

  // Strategy 1: /search.php?q=<encodedQuery>&page=<page>
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
  } catch (err: any) {
    console.warn(
      "RogMovies search.php failed, trying fallback search endpoints:",
      err?.message || err,
    );
  }

  // Strategy 2: Typesense search API (search.pingora.fyi)
  try {
    const today = new Date().toISOString().split("T")[0];
    const apiUrl = new URL(
      "https://search.pingora.fyi/collections/post/documents/search",
    );
    apiUrl.searchParams.append("q", cleanQuery);
    apiUrl.searchParams.append(
      "query_by",
      "post_title,category,stars,director,imdb_id",
    );
    apiUrl.searchParams.append("query_by_weights", "4,2,2,2,4");
    apiUrl.searchParams.append("sort_by", "sort_by_date:desc");
    apiUrl.searchParams.append("limit", "18");
    apiUrl.searchParams.append("highlight_fields", "none");
    apiUrl.searchParams.append("use_cache", "true");
    apiUrl.searchParams.append("page", String(page || 1));
    apiUrl.searchParams.append("analytics_tag", today);

    const tsRes = await axios.get(apiUrl.href, {
      signal,
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: `${baseUrl}/`,
        Origin: baseUrl,
      },
    });
    if (tsRes.data?.hits?.length) {
      return mapHitsToPosts(tsRes.data.hits);
    }
  } catch {}

  // Strategy 3: WordPress standard search /?s=<encodedQuery>
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
      console.warn(
        `RogMovies search restricted (${error?.response?.status}) on ${baseUrl}; returning empty list gracefully.`,
      );
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
      console.warn(
        `RogMovies catalog restricted (${error?.response?.status}) on ${url}; returning empty list gracefully.`,
      );
      return [];
    }
    throwProviderError("LuxMovies", "posts", error);
  }
}
