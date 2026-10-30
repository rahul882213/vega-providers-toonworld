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
    const response = await axios.get(url, {
      headers: { ...commonHeaders, Referer: BASE_URL },
    });
    const $ = cheerio.load(response.data);

    const title = (
      $("h1.entry-title, h1.post-title, article h1, main h1, h1").first().text() ||
      $("meta[property='og:title']").attr("content") ||
      $("title").text()
    )
      .replace(/\s+/g, " ")
      .trim();

    const image =
      $("meta[property='og:image']").attr("content") ||
      $(".post-thumbnail img, .entry-content img, article img").first().attr("data-src") ||
      $(".post-thumbnail img, .entry-content img, article img").first().attr("src") ||
      "";

    const synopsis =
      $("meta[name='description']").attr("content") ||
      $("meta[property='og:description']").attr("content") ||
      $(".entry-content p, article p")
        .filter((_i: number, el: any) => $(el).text().trim().length > 40)
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim() ||
      "";

    const tags: string[] = $(
      ".post-categories a, .cat-links a, .tags-links a, .entry-meta a[rel='tag']",
    )
      .map((_i: number, el: any) => $(el).text().trim())
      .get()
      .filter((tag: string) => Boolean(tag));

    const episodes: { title: string; link: string; isMovie?: boolean }[] = [];
    const seen = new Set<string>();

    $("a[href]").each((_i: number, element: any) => {
      const anchor = $(element);
      const href = anchor.attr("href");
      if (!href) return;
      try {
        const parsedUrl = new URL(href, url);
        const host = parsedUrl.hostname.toLowerCase();
        const pathname = parsedUrl.pathname.toLowerCase();

        // 1. Archive links (/episode/, /movie/, /series/, /redirect/)
        const isArchive =
          host === ARCHIVE_HOST || host.endsWith("toonworld4all.me");
        const isMediaRoute =
          pathname.startsWith("/episode/") ||
          pathname.startsWith("/movie/") ||
          pathname.startsWith("/series/") ||
          pathname.startsWith("/redirect/");

        // 2. Direct supported cloud extractors (HubCloud, GDFlix)
        const isCloudHost = /hubcloud|vcloud|gdflix/i.test(host);

        if ((isArchive && isMediaRoute) || isCloudHost) {
          if (!seen.has(parsedUrl.href)) {
            seen.add(parsedUrl.href);
            const anchorText = anchor.text().replace(/\s+/g, " ").trim();
            const isMovieLink = pathname.startsWith("/movie/");
            episodes.push({
              title: anchorText,
              link: parsedUrl.href,
              isMovie: isMovieLink,
            });
          }
        }
      } catch {
        /* Ignore malformed links. */
      }
    });

    // Detect whether post is a movie or TV series
    const isMovie =
      /movie/i.test(title) ||
      episodes.some((e) => e.isMovie) ||
      (!/season|episodes|series/i.test(title) &&
        !episodes.some((e) => e.link.includes("/episode/")));

    const linkList: Link[] = [];

    if (isMovie) {
      if (episodes.length > 0) {
        linkList.push({
          title: "Movie",
          quality: "1080p",
          directLinks: episodes.map((item, idx) => ({
            title:
              episodes.length > 1
                ? `Server ${idx + 1}`
                : item.title && !/watch|download|get/i.test(item.title)
                  ? item.title
                  : "Movie",
            link: item.link,
            type: "movie",
          })),
        });
      }
    } else {
      if (episodes.length > 0) {
        // Group episodes by Season if season pattern is found
        const seasonGroups = new Map<
          string,
          { title: string; link: string }[]
        >();

        episodes.forEach((ep) => {
          const seasonMatch =
            ep.link.match(/\/episode\/[^\/]+-(\d+)x(\d+)/i) ||
            ep.link.match(/s(?:eason)?[-_.]?(\d+)/i) ||
            title.match(/season\s*(\d+)/i);
          const seasonName = seasonMatch
            ? `Season ${parseInt(seasonMatch[1], 10)}`
            : "Season 1";

          if (!seasonGroups.has(seasonName)) {
            seasonGroups.set(seasonName, []);
          }
          seasonGroups.get(seasonName)!.push(ep);
        });

        for (const [seasonName, epList] of seasonGroups.entries()) {
          linkList.push({
            title: seasonName,
            directLinks: epList.map((ep, idx) => {
              const numMatch =
                ep.link.match(/(\d+)x(\d+)/) ||
                ep.title.match(/ep(?:isode)?\.?\s*(\d+)/i) ||
                ep.link.match(/ep(?:isode)?[-_.]?(\d+)/i);
              const epNum = numMatch
                ? parseInt(numMatch[2] || numMatch[1], 10)
                : idx + 1;
              const cleanTitle = `Episode ${epNum}`;

              return {
                title: cleanTitle,
                link: ep.link,
                type: "series",
              };
            }),
          });
        }
      }
    }

    return {
      title,
      image: image ? new URL(image, url).href : "",
      synopsis,
      imdbId: "",
      type: isMovie ? "movie" : "series",
      tags: [...new Set(tags)],
      linkList,
      webUrl: url,
    };
  } catch (error) {
    throwProviderError("ToonWorld4All", "metadata", error);
  }
};
