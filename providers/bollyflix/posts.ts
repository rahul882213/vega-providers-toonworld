import { Post, ProviderContext } from "../types";
import { getBaseUrl } from "../getBaseUrl";
import { throwProviderError } from "../providerErrors";

export const DEFAULT_BASE_URL = "https://bollyflix.church";

export const getBollyflixBaseUrl = async (providerContext?: ProviderContext): Promise<string> => {
  try {
    const override = await providerContext?.kvStore?.get<string>("baseUrlOverride");
    if (override && typeof override === "string" && override.trim().startsWith("http")) {
      return override.trim().replace(/\/+$/, "");
    }
  } catch {}

  try {
    const configuredUrl = await getBaseUrl("bollyflix");
    if (configuredUrl) return configuredUrl.replace(/\/+$/, "");
  } catch {}

  return DEFAULT_BASE_URL;
};

const defaultHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export const parseArticles = ($: any, baseUrl: string): Post[] => {
  const posts: Post[] = [];

  $("article").each((_: number, el: any) => {
    const $el = $(el);
    const linkEl = $el.find("header h2.title a, h2 a, a.post-image").first();
    const rawLink = linkEl.attr("href") || $el.find("a").first().attr("href");
    if (!rawLink) return;

    const link = rawLink.startsWith("http")
      ? rawLink
      : new URL(rawLink, baseUrl).href;

    const rawTitle =
      linkEl.text().trim() ||
      $el.find("a.post-image").attr("title") ||
      $el.find("img").attr("alt") ||
      "";

    if (!rawTitle) return;

    // Clean title for display: remove "Download " prefix
    const cleanTitle = rawTitle.replace(/^Download\s+/i, "").trim();

    // Extract resolution/quality tag
    const qualMatch = rawTitle.match(/(480p|720p|1080p|2160p|4k)/i);
    const tag = qualMatch ? qualMatch[1].toUpperCase() : undefined;

    // Image extraction
    const imgEl = $el.find("img").first();
    const image =
      imgEl.attr("src") ||
      imgEl.attr("data-src") ||
      imgEl.attr("data-lazy-src") ||
      imgEl.attr("data-wpel-link") ||
      "";

    posts.push({
      title: cleanTitle,
      link,
      image,
      tag,
      provider: "bollyflix",
    });
  });

  return posts;
};

export const getPosts = async function ({
  filter,
  page,
  signal,
  providerContext,
}: {
  filter: string;
  page: number;
  providerValue: string;
  providerContext: ProviderContext;
  signal: AbortSignal;
}): Promise<Post[]> {
  const { axios, cheerio, commonHeaders } = providerContext;
  const baseUrl = await getBollyflixBaseUrl(providerContext);

  let targetUrl = baseUrl;
  const cleanFilter = (filter || "").trim().replace(/^\/+|\/+$/g, "");

  if (page <= 1) {
    targetUrl = cleanFilter ? `${baseUrl}/${cleanFilter}/` : `${baseUrl}/`;
  } else {
    targetUrl = cleanFilter
      ? `${baseUrl}/${cleanFilter}/page/${page}/`
      : `${baseUrl}/page/${page}/`;
  }

  try {
    const res = await axios.get(targetUrl, {
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: baseUrl + "/",
      },
      signal,
      timeout: 15000,
    });

    const $ = cheerio.load(res.data);
    return parseArticles($, baseUrl);
  } catch (err: any) {
    return throwProviderError("bollyflix", "getPosts", err);
  }
};

export const getSearchPosts = async function ({
  searchQuery,
  page,
  signal,
  providerContext,
}: {
  searchQuery: string;
  page: number;
  providerValue: string;
  providerContext: ProviderContext;
  signal: AbortSignal;
}): Promise<Post[]> {
  const { axios, cheerio, commonHeaders } = providerContext;
  const baseUrl = await getBollyflixBaseUrl(providerContext);

  const query = encodeURIComponent(searchQuery || "");
  let targetUrl = "";

  if (page <= 1) {
    targetUrl = `${baseUrl}/?s=${query}`;
  } else {
    targetUrl = `${baseUrl}/page/${page}/?s=${query}`;
  }

  try {
    const res = await axios.get(targetUrl, {
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: baseUrl + "/",
      },
      signal,
      timeout: 15000,
    });

    const $ = cheerio.load(res.data);
    return parseArticles($, baseUrl);
  } catch (err: any) {
    return throwProviderError("bollyflix", "getSearchPosts", err);
  }
};
