import { Post, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import { getCinewoodBaseUrl, getWithWAF } from "./helper";

// --- Normal catalog posts ---
export async function getPosts({
  filter,
  page = 1,
  signal,
  providerContext,
}: {
  filter?: string;
  page?: number;
  signal?: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  return fetchPosts({ filter, page, query: "", signal, providerContext });
}

// --- Search posts ---
export async function getSearchPosts({
  searchQuery,
  page = 1,
  signal,
  providerContext,
}: {
  searchQuery: string;
  page?: number;
  signal?: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  return fetchPosts({
    filter: "",
    page,
    query: searchQuery,
    signal,
    providerContext,
  });
}

// --- Core function ---
async function fetchPosts({
  filter,
  query,
  page = 1,
  providerContext,
}: {
  filter?: string;
  query?: string;
  page?: number;
  signal?: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  try {
    const baseUrl = (await getCinewoodBaseUrl()).replace(/\/+$/, "");
    let url: string;

    if (query && query.trim()) {
      const encodedQuery = encodeURIComponent(query.trim());
      url =
        page > 1
          ? `${baseUrl}/page/${page}/?s=${encodedQuery}`
          : `${baseUrl}/?s=${encodedQuery}`;
    } else if (filter && filter.trim()) {
      const cleanFilter = filter.trim().replace(/^\/+|\/+$/g, "");
      url =
        page > 1
          ? `${baseUrl}/${cleanFilter}/page/${page}/`
          : `${baseUrl}/${cleanFilter}/`;
    } else {
      url = page > 1 ? `${baseUrl}/page/${page}/` : `${baseUrl}/`;
    }

    const { axios, cheerio, commonHeaders, openWebView } = providerContext;
    const res = await getWithWAF(url, axios, openWebView, commonHeaders);
    const $ = cheerio.load(res.data || "");

    const resolveUrl = (href: string) =>
      href?.startsWith("http") ? href : new URL(href, url).href;

    const seen = new Set<string>();
    const catalog: Post[] = [];

    const POST_SELECTORS = [
      "article.latestPost",
      "article",
      ".pstr_box",
      ".result-item",
      ".post",
      ".item",
      ".thumbnail",
      ".latest-movies",
      ".movie-item",
    ].join(",");

    $(POST_SELECTORS).each((_, el) => {
      const card = $(el);
      let link =
        card
          .find("h1.entry-title a[href], h2.entry-title a[href], h2 a[href]")
          .first()
          .attr("href") ||
        card.find("a#featured-thumbnail[href], a[href]").first().attr("href") ||
        "";
      if (!link) return;

      const postUrl = new URL(link, url);
      link = `${postUrl.pathname}${postUrl.search}${postUrl.hash}`;
      if (
        !link ||
        link === "/" ||
        /^\/(?:category|tag|page|author|contect-us|dmca|request-a-movies|how-to-download)\b/i.test(
          link,
        ) ||
        seen.has(link)
      ) {
        return;
      }

      const rawTitle =
        card
          .find("h1.entry-title, h2.entry-title, h2, h3")
          .first()
          .text()
          .trim() ||
        card.find("a[title]").first().attr("title")?.trim() ||
        card.find("img[alt]").first().attr("alt")?.trim() ||
        card.text().trim();

      let title = rawTitle
        .replace(/^Download\s+/i, "")
        .replace(/\[.*?\]/g, "")
        .replace(/\{.*?\}/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();

      const yearTitleMatch = title.match(/^(.+?\(\d{4}\))/);
      if (yearTitleMatch) {
        title = yearTitleMatch[1].trim();
      } else {
        title = title.replace(/\s*\|.*$/, "").trim();
      }
      if (!title) return;

      const img =
        card.find("img").first().attr("src") ||
        card.find("img").first().attr("data-src") ||
        card.find("img").first().attr("data-original") ||
        "";
      const image = img ? resolveUrl(img) : "";

      seen.add(link);
      catalog.push({ title, link, image });
    });

    return catalog.slice(0, 100);
  } catch (err) {
    throwProviderError(
      "1CineVood",
      query && query.trim() ? "search posts" : "posts",
      err,
    );
  }
}
