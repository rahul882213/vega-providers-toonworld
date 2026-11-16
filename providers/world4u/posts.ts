import { Post, ProviderContext } from "../types";
import { getBaseUrl } from "../getBaseUrl";
import { throwProviderError } from "../providerErrors";

const DEFAULT_W4U_BASE_URL = "https://world4ufree.co.in";

const defaultHeaders: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export function normalizeWorld4uImageUrl(
  rawUrl: string | undefined,
  baseUrl: string = DEFAULT_W4U_BASE_URL,
): string {
  if (!rawUrl || typeof rawUrl !== "string") return "";
  let img = rawUrl.trim();
  if (!img || img.startsWith("data:")) return "";
  if (img.startsWith("//")) img = `https:${img}`;
  else if (img.startsWith("/")) img = `${baseUrl.replace(/\/+$/, "")}${img}`;

  // World4uFree hotlink-protects /wp-content/uploads/ (returns HTTP 403 without Referer),
  // and its uploaded filenames are exact TMDB poster hashes. Rewrite to image.tmdb.org.
  const tmdbHashMatch = img.match(
    /\/wp-content\/uploads\/(?:\d{4}\/\d{2}\/)?([A-Za-z0-9_-]{20,40}?)(?:-\d+x\d+)?\.(jpe?g|png|webp)(?:[?#].*)?$/i,
  );
  if (tmdbHashMatch) {
    return `https://image.tmdb.org/t/p/w500/${tmdbHashMatch[1]}.${tmdbHashMatch[2].toLowerCase()}`;
  }
  return img;
}

export function extractWorld4uImgAttr(imgEl: any, baseUrl: string): string {
  if (!imgEl || typeof imgEl.attr !== "function") return "";
  const candidates = [
    imgEl.attr("data-original"),
    imgEl.attr("data-lazy-src"),
    imgEl.attr("data-src"),
    imgEl.attr("src"),
  ];
  for (const c of candidates) {
    const cleaned = normalizeWorld4uImageUrl(c, baseUrl);
    if (cleaned) return cleaned;
  }
  return "";
}

export async function getWorld4uBaseUrl(): Promise<string> {
  try {
    const raw = await getBaseUrl("w4u");
    if (!raw || /world4ufree\.vu|world4ufree\.ind\.in/i.test(raw)) {
      return DEFAULT_W4U_BASE_URL;
    }
    return raw.replace(/\/+$/, "");
  } catch {
    return DEFAULT_W4U_BASE_URL;
  }
}

function mapLegacyFilter(filter: string): string {
  const clean = (filter || "").trim().replace(/^\/+|\/+$/g, "");
  if (!clean) return "";
  if (/^category\/web-series$/i.test(clean)) return "tvshows";
  if (/^category\/(?:hollywood|bollywood|punjabi|gujarati)/i.test(clean)) {
    return "movies";
  }
  return clean;
}

export const getPosts = async function ({
  filter,
  page = 1,
  signal,
  providerContext,
}: {
  filter: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  const { axios, cheerio, commonHeaders } = providerContext;
  const baseUrl = await getWorld4uBaseUrl();
  const cleanFilter = mapLegacyFilter(filter);
  const url = cleanFilter
    ? page > 1
      ? `${baseUrl}/${cleanFilter}/page/${page}/`
      : `${baseUrl}/${cleanFilter}/`
    : page > 1
      ? `${baseUrl}/page/${page}/`
      : `${baseUrl}/`;

  return posts({
    baseUrl,
    url,
    signal,
    axios,
    cheerio,
    commonHeaders,
    operation: "posts",
  });
};

export const getSearchPosts = async function ({
  searchQuery,
  page = 1,
  signal,
  providerContext,
}: {
  searchQuery: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  const { axios, cheerio, commonHeaders } = providerContext;
  const baseUrl = await getWorld4uBaseUrl();
  const encodedQuery = encodeURIComponent((searchQuery || "").trim());
  const url =
    page > 1
      ? `${baseUrl}/page/${page}/?s=${encodedQuery}`
      : `${baseUrl}/?s=${encodedQuery}`;

  return posts({
    baseUrl,
    url,
    signal,
    axios,
    cheerio,
    commonHeaders,
    operation: "search posts",
  });
};

async function posts({
  baseUrl,
  url,
  signal,
  axios,
  cheerio,
  commonHeaders,
  operation,
}: {
  baseUrl: string;
  url: string;
  signal: AbortSignal;
  axios: ProviderContext["axios"];
  cheerio: ProviderContext["cheerio"];
  commonHeaders?: Record<string, string>;
  operation: string;
}): Promise<Post[]> {
  try {
    const res = await axios.get(url, {
      signal,
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: `${baseUrl}/`,
      },
    });
    const data = res.data;
    const $ = cheerio.load(data);
    const catalog: Post[] = [];
    const seen = new Set<string>();

    // 1. Modern Zetaflix cards (.item-box, .module-item, .result-item, article.item)
    $(".item-box, .module-item, .result-item, article.item").each(
      (_, element) => {
        const card = $(element);
        const anchor = card.find("a[href]").first();
        const rawHref = anchor.attr("href") || "";
        if (!rawHref || rawHref === "#" || rawHref.startsWith("javascript:")) {
          return;
        }

        const postUrl = new URL(rawHref, `${baseUrl}/`);
        const normalizedLink = `${postUrl.pathname}${postUrl.search}${postUrl.hash}`;
        if (
          !normalizedLink ||
          normalizedLink === "/" ||
          seen.has(normalizedLink)
        ) {
          return;
        }

        const title = (
          anchor.attr("title") ||
          card
            .find(".item-desc-title h3, .item-data h3, h3, h2, .title")
            .first()
            .text() ||
          card.find("img").first().attr("alt") ||
          ""
        )
          .replace(/^Download\s+/i, "")
          .replace(/\s+/g, " ")
          .trim();

        const imgEl = card.find("img").first();
        const image = extractWorld4uImgAttr(imgEl, baseUrl);

        if (title && normalizedLink) {
          seen.add(normalizedLink);
          catalog.push({
            title,
            link: normalizedLink,
            image,
          });
        }
      },
    );

    // 2. Legacy .recent-posts layout fallback
    if (catalog.length === 0) {
      $(".recent-posts")
        .children()
        .each((_, element) => {
          const title = $(element).find(".post-thumb a").attr("title");
          const link = $(element).find(".post-thumb a").attr("href");
          const image = extractWorld4uImgAttr($(element).find(".post-thumb img").first(), baseUrl);
          if (title && link && image) {
            const postUrl = new URL(link, `${baseUrl}/`);
            const normalizedLink = `${postUrl.pathname}${postUrl.search}${postUrl.hash}`;
            if (!seen.has(normalizedLink)) {
              seen.add(normalizedLink);
              catalog.push({
                title: title.replace("Download", "").trim(),
                link: normalizedLink,
                image,
              });
            }
          }
        });
    }

    return catalog;
  } catch (err: any) {
    if (operation === "search posts" && err?.response?.status === 404) {
      return [];
    }
    throwProviderError("World4u", operation, err);
  }
}
