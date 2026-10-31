import { Info, Link, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";

const BASE_URL = "https://toonworld4all.me";
const ARCHIVE_HOST = "archive.toonworld4all.me";

interface ScrapedEpisode {
  title: string;
  link: string;
  isMovie?: boolean;
  seasonNumber: number;
  episodeNumber: number;
}

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
      headers: {
        ...commonHeaders,
        Referer: BASE_URL,
        "User-Agent":
          commonHeaders["User-Agent"] ||
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
    });
    const $ = cheerio.load(response.data);

    // Extract raw title and clean it
    const rawTitle = (
      $("h1.entry-title, h1.post-title, article h1, main h1, h1").first().text() ||
      $("meta[property='og:title']").attr("content") ||
      $("title").text()
    )
      .replace(/\s+/g, " ")
      .trim();

    // Clean title for nice display (e.g. "Naruto: Shippuden Season 18")
    const cleanTitle =
      rawTitle
        .replace(/^download\s+/i, "")
        .split(/\s+(?:\[|\d+p\b|bluray\b|multi\s+audio\b|web-dl\b|ddp\d|dd2)/i)[0]
        .replace(/\|.*$/, "")
        .trim() || rawTitle;

    const image =
      $("meta[property='og:image']").attr("content") ||
      $(".post-thumbnail img, .entry-content img, article img").first().attr("data-src") ||
      $(".post-thumbnail img, .entry-content img, article img").first().attr("src") ||
      "";

    // Extract and clean synopsis
    let synopsis =
      $("meta[name='description']").attr("content") ||
      $("meta[property='og:description']").attr("content") ||
      $(".entry-content p, article p")
        .filter((_i: number, el: any) => $(el).text().trim().length > 40)
        .first()
        .text()
        .replace(/\s+/g, " ")
        .trim() ||
      "";

    if (synopsis.includes("Synopsis:")) {
      synopsis = synopsis.split(/synopsis\s*:\s*/i).pop()?.trim() || synopsis;
    }

    const tags: string[] = $(
      ".post-categories a, .cat-links a, .tags-links a, .entry-meta a[rel='tag']",
    )
      .map((_i: number, el: any) => $(el).text().trim())
      .get()
      .filter((tag: string) => Boolean(tag));

    // Detect overall series season from post title if available (e.g. "Season 18")
    const titleSeasonMatch = rawTitle.match(/season\s*(\d+)/i);
    const globalSeason = titleSeasonMatch
      ? parseInt(titleSeasonMatch[1], 10)
      : 1;

    const episodes: ScrapedEpisode[] = [];
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

            const isMovieLink = pathname.startsWith("/movie/");
            const anchorText = anchor.text().replace(/\s+/g, " ").trim();
            const parentText = anchor.parent().text().replace(/\s+/g, " ").trim();

            // Extract episode number
            let epNum = 0;
            let seasonNum = globalSeason;

            // Pattern 1: URL format like 1x373 or 2x5
            const urlPairMatch = pathname.match(/(\d+)x(\d+)/i);
            if (urlPairMatch) {
              const uSeason = parseInt(urlPairMatch[1], 10);
              const uEpisode = parseInt(urlPairMatch[2], 10);
              epNum = uEpisode;
              // If title did not explicitly specify a season, adopt the URL season
              if (!titleSeasonMatch && uSeason > 0) {
                seasonNum = uSeason;
              }
            }

            // Pattern 2: URL format like episode-373 or ep-5
            if (!epNum) {
              const urlEpMatch = pathname.match(/ep(?:isode)?[-_.]?(\d+)/i);
              if (urlEpMatch) {
                epNum = parseInt(urlEpMatch[1], 10);
              }
            }

            // Pattern 3: Parent text "Episode 373:" or anchor text
            if (!epNum) {
              const textMatch =
                parentText.match(/ep(?:isode)?\.?\s*(\d+)/i) ||
                anchorText.match(/ep(?:isode)?\.?\s*(\d+)/i);
              if (textMatch) {
                epNum = parseInt(textMatch[1], 10);
              }
            }

            // Fallback: sequential numbering later if epNum is still 0
            episodes.push({
              title: anchorText,
              link: parsedUrl.href,
              isMovie: isMovieLink,
              seasonNumber: seasonNum,
              episodeNumber: epNum,
            });
          }
        }
      } catch {
        /* Ignore malformed links. */
      }
    });

    // Detect whether post is a movie or TV series
    const isMovie =
      /movie/i.test(rawTitle) ||
      episodes.some((e) => e.isMovie) ||
      (!/season|episodes|series/i.test(rawTitle) &&
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
                  : "Full Movie",
            link: item.link,
            type: "movie",
          })),
        });
      }
    } else {
      if (episodes.length > 0) {
        // Group episodes by Season
        const seasonGroups = new Map<number, ScrapedEpisode[]>();

        episodes.forEach((ep, idx) => {
          const sNum = ep.seasonNumber || globalSeason || 1;
          if (!seasonGroups.has(sNum)) {
            seasonGroups.set(sNum, []);
          }
          // If episodeNumber was not detected, assign sequential index + 1
          if (!ep.episodeNumber) {
            ep.episodeNumber = idx + 1;
          }
          seasonGroups.get(sNum)!.push(ep);
        });

        // Sort seasons ascending
        const sortedSeasons = [...seasonGroups.keys()].sort((a, b) => a - b);

        for (const sNum of sortedSeasons) {
          const epList = seasonGroups.get(sNum)!;
          // Sort episodes ascending by episodeNumber
          epList.sort((a, b) => a.episodeNumber - b.episodeNumber);

          const seasonTitle = `Season ${sNum}`;

          linkList.push({
            title: seasonTitle,
            directLinks: epList.map((ep) => ({
              title: `Episode ${ep.episodeNumber}`,
              link: ep.link,
              type: "series",
            })),
          });
        }
      }
    }

    return {
      title: cleanTitle,
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
