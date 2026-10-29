import { Post, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";

const BASE_URL = "https://toonworld4all.me";

export const getPosts = async function ({
  filter,
  page,
  signal,
  providerContext,
}: {
  filter: string;
  page: number;
  providerValue: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  const path = filter || "/";
  const pagePath = page > 1 ? `${path.replace(/\/$/, "")}/page/${page}/` : path;
  return fetchPosts({ url: new URL(pagePath, BASE_URL).href, signal, providerContext, operation: "posts" });
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
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Post[]> {
  const url = new URL(page > 1 ? `/page/${page}/` : "/", BASE_URL);
  url.searchParams.set("s", searchQuery);
  return fetchPosts({ url: url.href, signal, providerContext, operation: "search posts" });
};

async function fetchPosts({
  url,
  signal,
  providerContext,
  operation,
}: {
  url: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
  operation: string;
}): Promise<Post[]> {
  try {
    const { axios, cheerio, commonHeaders } = providerContext;
    const response = await axios.get(url, { signal, headers: { ...commonHeaders, Referer: BASE_URL } });
    const $ = cheerio.load(response.data);
    const results: Post[] = [];
    const seen = new Set<string>();

    // WordPress themes vary; support common article/card structures and filter
    // out navigation/category links by requiring both a title and an image.
    $(".herald-lay-a, .herald-lay-b, .herald-lay-c, .herald-lay-d, .herald-lay-e, .herald-lay-f, .herald-lay-g, .herald-lay-h, .herald-lay-i, .herald-lay-j, .herald-lay-k, .herald-lay-l, article").each((_i: number, element: any) => {
      const card = $(element);
      const anchor = card.find("h1 a, h2 a, h3 a, .entry-title a, .post-title a, a[rel='bookmark']").first();
      const href = anchor.attr("href") || card.find("a[href]").first().attr("href");
      const title = (anchor.text() || card.find("h1, h2, h3, .entry-title, .post-title").first().text()).replace(/\s+/g, " ").trim();
     const image = card.find("img.wp-post-image").first().attr("src") || card.find("img.wp-post-image").first().attr("data-src") || card.find("img").first().attr("src");
      if (!href || !title || !image) return;
      try {
        const postUrl = new URL(href, BASE_URL);
        const imageUrl = new URL(image, BASE_URL).href;
        if (postUrl.hostname !== new URL(BASE_URL).hostname || seen.has(postUrl.href)) return;
        seen.add(postUrl.href);
        results.push({ title, link: `${postUrl.pathname}${postUrl.search}`, image: imageUrl });
      } catch { /* Ignore malformed card URLs. */ }
    });

    // Fallback for themes whose cards are not wrapped in article elements.
    if (results.length === 0) {
      $(".entry-title a, .post-title a, h2 a, h3 a").each((_i: number, element: any) => {
        const anchor = $(element);
        const href = anchor.attr("href");
        const title = anchor.text().replace(/\s+/g, " ").trim();
        const card = anchor.closest("article, .post, .type-post, .post-item, .entry, li, div");
        const image = card.find("img").first().attr("data-src") || card.find("img").first().attr("src");
        if (!href || !title || !image) return;
        try {
          const postUrl = new URL(href, BASE_URL);
          if (postUrl.hostname !== new URL(BASE_URL).hostname || seen.has(postUrl.href)) return;
          seen.add(postUrl.href);
          results.push({ title, link: `${postUrl.pathname}${postUrl.search}`, image: new URL(image, BASE_URL).href });
        } catch { /* Ignore malformed card URLs. */ }
      });
    }
    return results;
  } catch (error) {
    throwProviderError("ToonWorld4All", operation, error);
  }
}
