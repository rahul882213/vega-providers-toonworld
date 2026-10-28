import { Info, Link, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";

const BASE_URL = "https://toonworld4all.me";
const ARCHIVE_HOST = "archive.toonworld4all.me";

export const getMeta = async function ({
  link,
  providerContext,
}: {
  link: string;
  providerContext: ProviderContext;
}): Promise<Info> {
  try {
    const { axios, cheerio, commonHeaders } = providerContext;
    const url = new URL(link, BASE_URL).href;
    const response = await axios.get(url, { headers: { ...commonHeaders, Referer: BASE_URL } });
    const $ = cheerio.load(response.data);
    const title = ($("h1.entry-title, h1.post-title, article h1, main h1, h1").first().text() || $("meta[property='og:title']").attr("content") || $("title").text()).replace(/\s+/g, " ").trim();
    const image = $("meta[property='og:image']").attr("content") || $(".post-thumbnail img, .entry-content img, article img").first().attr("data-src") || $(".post-thumbnail img, .entry-content img, article img").first().attr("src") || "";
    const synopsis = $("meta[name='description']").attr("content") || $("meta[property='og:description']").attr("content") || $(".entry-content p, article p").filter((_i: number, el: any) => $(el).text().trim().length > 40).first().text().replace(/\s+/g, " ").trim() || "";
    const tags: string[] = $(".post-categories a, .cat-links a, .tags-links a, .entry-meta a[rel='tag']").map((_i: number, el: any) => $(el).text().trim()).get().filter((tag: string) => Boolean(tag));
    const linkList: Link[] = [];
    const episodes: { title: string; link: string }[] = [];
    const seen = new Set<string>();

    // Episode pages are treated as navigation metadata only. Do not follow or
    // extract third-party file-host/download URLs.
    $("a[href]").each((_i: number, element: any) => {
      const anchor = $(element);
      const href = anchor.attr("href");
      if (!href) return;
      try {
        const episodeUrl = new URL(href, url);
        if (episodeUrl.hostname !== ARCHIVE_HOST || !episodeUrl.pathname.startsWith("/episode/")) return;
        if (seen.has(episodeUrl.href)) return;
        seen.add(episodeUrl.href);
        const episodeTitle = anchor.text().replace(/\s+/g, " ").trim() || episodeUrl.pathname.split("/").filter(Boolean).pop() || "Episode";
        episodes.push({ title: episodeTitle, link: episodeUrl.href });
      } catch { /* Ignore malformed links. */ }
    });

    if (episodes.length > 0) {
      linkList.push({ title: "Episodes", directLinks: episodes.map((episode) => ({ title: episode.title, link: episode.link, type: "series" })) });
    }

    return {
      title,
      image: image ? new URL(image, url).href : "",
      synopsis,
      imdbId: "",
      type: episodes.length > 0 || /season|episodes|series/i.test(title) ? "series" : "movie",
      tags: [...new Set(tags)],
      linkList,
      webUrl: url,
    };
  } catch (error) {
    throwProviderError("ToonWorld4All", "metadata", error);
  }
}
