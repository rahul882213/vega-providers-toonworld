import { Info, Link, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import { applyCinemetaMeta, getCinemetaMeta } from "../getCinemetaMeta";
import { extractWorld4uImgAttr, getWorld4uBaseUrl, normalizeWorld4uImageUrl } from "./posts";

const defaultHeaders: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export interface W4uStreamMeta {
  postId?: string;
  postType?: string;
  season?: number;
  episode?: number;
  tmdbId?: string;
  imdbId?: string;
  title?: string;
  year?: string;
  posterFile?: string;
  type?: string;
}

export function attachW4uMeta(targetUrl: string, meta: W4uStreamMeta): string {
  try {
    const parsed = new URL(targetUrl);
    const params = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    params.set("w4uMeta", JSON.stringify(meta));
    parsed.hash = params.toString();
    return parsed.href;
  } catch {
    return targetUrl;
  }
}

export function readW4uMeta(rawUrl: string): {
  requestUrl: string;
  meta: W4uStreamMeta;
} {
  try {
    const parsed = new URL(rawUrl);
    const params = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const rawMeta = params.get("w4uMeta");
    parsed.hash = "";
    if (rawMeta) {
      return {
        requestUrl: parsed.href,
        meta: JSON.parse(rawMeta) as W4uStreamMeta,
      };
    }
    return { requestUrl: parsed.href, meta: {} };
  } catch {
    return { requestUrl: rawUrl.split("#")[0], meta: {} };
  }
}

export async function lookupTmdbByTitleAndPoster({
  title,
  year,
  posterFile,
  type,
  axios,
  commonHeaders,
}: {
  title: string;
  year?: string;
  posterFile?: string;
  type: "movie" | "series";
  axios: ProviderContext["axios"];
  commonHeaders?: Record<string, string>;
}): Promise<{ tmdbId: string; imdbId: string; year: string; posterPath?: string }> {
  let tmdbId = "";
  let imdbId = "";
  let resolvedYear = year || "";
  let posterPath = "";

  if (!title) return { tmdbId, imdbId, year: resolvedYear, posterPath };

  const mediaKind = type === "series" ? "tv" : "movie";
  try {
    const searchUrl = `https://db.wecollege.net/3/search/${mediaKind}?query=${encodeURIComponent(
      title,
    )}`;
    const sRes = await axios.get(searchUrl, {
      headers: {
        Referer: "https://www.movy.sx/",
        Origin: "https://www.movy.sx",
        ...commonHeaders,
      },
      timeout: 5000,
    });
    const results: any[] = sRes.data?.results || [];
    if (results.length > 0) {
      const matched =
        results.find(
          (r) =>
            posterFile &&
            typeof r.poster_path === "string" &&
            r.poster_path.endsWith(posterFile),
        ) ||
        results.find((r) => {
          const rYear = String(r.release_date || r.first_air_date || "").slice(
            0,
            4,
          );
          return (
            year &&
            rYear === year &&
            String(r.title || r.name || "").toLowerCase() ===
              title.toLowerCase()
          );
        }) ||
        results.find((r) => {
          const rYear = String(r.release_date || r.first_air_date || "").slice(
            0,
            4,
          );
          return year && rYear === year;
        }) ||
        results[0];

      if (matched?.id) {
        tmdbId = String(matched.id);
        if (typeof matched.poster_path === "string" && matched.poster_path) {
          posterPath = matched.poster_path;
        }
        if (!resolvedYear) {
          resolvedYear = String(
            matched.release_date || matched.first_air_date || "",
          ).slice(0, 4);
        }
      }
    }
  } catch {}

  if (tmdbId) {
    try {
      const detailUrl = `https://db.wecollege.net/3/${mediaKind}/${tmdbId}?append_to_response=external_ids`;
      const dRes = await axios.get(detailUrl, {
        headers: {
          Referer: "https://www.movy.sx/",
          Origin: "https://www.movy.sx",
          ...commonHeaders,
        },
        timeout: 4500,
      });
      if (dRes.data?.external_ids?.imdb_id) {
        imdbId = String(dRes.data.external_ids.imdb_id);
      }
    } catch {}
  }

  return { tmdbId, imdbId, year: resolvedYear, posterPath };
}

export const getMeta = async function ({
  link,
  providerContext,
}: {
  link: string;
  providerContext: ProviderContext;
  providerValue?: string;
}): Promise<Info> {
  try {
    const { axios, cheerio, commonHeaders } = providerContext;
    const baseUrl = await getWorld4uBaseUrl();
    const url = new URL(link, `${baseUrl}/`).href;
    const res = await axios.get(url, {
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: `${baseUrl}/`,
      },
    });
    const data = res.data;
    const $ = cheerio.load(data);

    const rawHeading =
      $(".data h3, .details h3, .s-desc h3, .item-desc-title h3, h3").first().text().trim() ||
      $("img.poster-img").attr("title") ||
      $("meta[property='og:title']").attr("content") ||
      $("h1, .entry-title, .details-title h3, title").first().text();

    const pageTitle = rawHeading
      .replace(/^World4uFree\s*[-–|:]\s*/i, "")
      .replace(/\s*[-–|:]\s*World4uFree.*$/i, "")
      .replace(/^Download\s+/i, "")
      .replace(/Full HD Movie Download Free/i, "")
      .replace(/Download Free/i, "")
      .trim();

    const hasZetaflixEpisodes = $("ul.episodes-list li").length > 0;
    const isSeries =
      /\/tvshows\/|\/episodes\//i.test(url) ||
      hasZetaflixEpisodes ||
      ((/season\s*\d+/i.test(pageTitle) ||
        /\[\s*s\d{1,2}\s*\]/i.test(pageTitle) ||
        /(?:web\s*series|tv\s*series|series)/i.test(pageTitle) ||
        /\[\s*s\d{1,2}\s*e\d{1,2}\s*\]/i.test(pageTitle) ||
        /\[\s*e\d{1,2}\s*added\s*\]/i.test(pageTitle)) &&
        !pageTitle.toLowerCase().includes("full movie"));
    const type: "movie" | "series" = isSeries ? "series" : "movie";

    let imdbId =
      $(".imdb_left a, a[href*='imdb.com/title/tt']")
        .first()
        .attr("href")
        ?.match(/tt\d+/)?.[0] || "";

    let title =
      $(".details-title h3, .details-title h1").first().text().trim() ||
      $(".entry-content")
        .find('strong:contains("Name")')
        .first()
        .children()
        .remove()
        .end()
        .text()
        .replace(":", "")
        .replace(/\[.*?\]|\(.*?\)|\|.*/g, "")
        .trim();

    if (!title) {
      title = pageTitle.replace(/\[.*?\]|\(.*?\)|\|.*/g, "").trim();
    }

    const synopsis =
      $(".details-desc p").first().text().trim() ||
      $(".entry-content")
        .find('p:contains("Synopsis"),p:contains("Plot"),p:contains("Story")')
        .first()
        .children()
        .remove()
        .end()
        .text()
        .trim() ||
      $("meta[property='og:description']").attr("content")?.trim() ||
      "";

    let image =
      extractWorld4uImgAttr($(".content-poster img").first(), baseUrl) ||
      normalizeWorld4uImageUrl($("meta[property='og:image']").attr("content"), baseUrl) ||
      extractWorld4uImgAttr($(".splash-bg img").first(), baseUrl) ||
      extractWorld4uImgAttr($(".wp-caption img").first(), baseUrl) ||
      extractWorld4uImgAttr($(".entry-content img").first(), baseUrl) ||
      "";

    const tags = $(".details-genre a")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);

    const infoText = $(".details-info, .info-col, .details-data").text();
    const yearMatch = infoText.match(/Year:\s*(\d{4})/i)?.[1] || "";
    const posterFile = image.split("/").pop()?.split("?")[0] || "";

    const tmdbResolved = await lookupTmdbByTitleAndPoster({
      title,
      year: yearMatch,
      posterFile,
      type,
      axios,
      commonHeaders,
    });
    const tmdbId = tmdbResolved.tmdbId;
    if (!imdbId && tmdbResolved.imdbId) {
      imdbId = tmdbResolved.imdbId;
    }
    const year = yearMatch || tmdbResolved.year;
    if ((!image || /world4ufree\./i.test(image)) && tmdbResolved.posterPath) {
      image = `https://image.tmdb.org/t/p/w500${tmdbResolved.posterPath}`;
    }

    const links: Link[] = [];

    // 1. Zetaflix TV Show seasons & episodes
    if (type === "series" && hasZetaflixEpisodes) {
      $("ul.episodes-list").each((idx, ulEl) => {
        const ul = $(ulEl);
        const idAttr = ul.attr("id") || "";
        const seasonNum = Number(
          idAttr.match(/season-listep-(\d+)/i)?.[1] || idx + 1,
        );
        const seasonUrl = attachW4uMeta(url, {
          season: seasonNum,
          tmdbId,
          imdbId,
          title,
          year,
          posterFile,
          type: "series",
        });

        const directLinks: NonNullable<Link["directLinks"]> = [];
        ul.find("li").each((epIdx, liEl) => {
          const li = $(liEl);
          const epHref = li.find("a[href]").first().attr("href") || "";
          if (!epHref) return;
          const epNum = Number(
            li.find(".ep-num").first().text().trim() || epIdx + 1,
          );
          const epName = li.find(".ep-title").first().text().trim();
          const epLabel = epName
            ? `Episode ${String(epNum).padStart(2, "0")} - ${epName}`
            : `Episode ${String(epNum).padStart(2, "0")}`;
          const fullEpUrl = attachW4uMeta(new URL(epHref, `${baseUrl}/`).href, {
            season: seasonNum,
            episode: epNum,
            tmdbId,
            imdbId,
            title,
            year,
            posterFile,
            type: "series",
          });
          directLinks.push({
            title: epLabel,
            link: fullEpUrl,
            type: "series",
          });
        });

        links.push({
          title: `Season ${seasonNum}`,
          quality: "1080p",
          episodesLink: seasonUrl,
          directLinks,
        });
      });
    }

    // 2. Zetaflix Movie player / download links
    if (
      type === "movie" &&
      ($("#playeroptionsul li, .zetaflix_player_option").length > 0 ||
        /\/movies\//i.test(url))
    ) {
      const firstOpt = $(
        "#playeroptionsul li, .zetaflix_player_option",
      ).first();
      const postId =
        firstOpt.attr("data-post") ||
        $("body")
          .attr("class")
          ?.match(/\bpostid-(\d+)\b/)?.[1] ||
        "";

      const movieStreamUrl = attachW4uMeta(url, {
        postId,
        postType: "mv",
        tmdbId,
        imdbId,
        title,
        year,
        posterFile,
        type: "movie",
      });

      links.push({
        title: `${title}${year ? ` (${year})` : ""} [1080p HD]`,
        quality: "1080p",
        episodesLink: "",
        directLinks: [
          {
            title: "Movie (1080p HD)",
            link: movieStreamUrl,
            type: "movie",
          },
        ],
      });
    }

    // 3. Legacy .my-button layout fallback
    if (links.length === 0) {
      $(".my-button").each((_, element) => {
        const linkTitle = $(element)
          .parent()
          .parent()
          .prev()
          .text()
          .trim()
          .replace(/[\r\n\t]+/g, " ");
        const episodesLink = $(element).attr("href");
        const quality =
          linkTitle.match(/\b(480p|720p|1080p|2160p)\b/i)?.[0] || "";
        if (episodesLink && linkTitle) {
          links.push({
            title: linkTitle,
            episodesLink: type === "series" ? episodesLink : "",
            directLinks:
              type === "movie"
                ? [
                    {
                      link: episodesLink,
                      title: linkTitle,
                      type: "movie",
                    },
                  ]
                : [],
            quality,
          });
        }
      });
    }

    const result: Info = {
      title,
      synopsis,
      image,
      imdbId,
      tmdbId: tmdbId || undefined,
      type,
      tags: tags.length > 0 ? tags : undefined,
      linkList: links,
      webUrl: url,
    };

    if (imdbId) {
      try {
        const cinemeta = await getCinemetaMeta(imdbId, type, providerContext);
        if (cinemeta) {
          return applyCinemetaMeta(result, cinemeta);
        }
      } catch {}
    }

    return result;
  } catch (err) {
    throwProviderError("World4u", "metadata", err);
  }
};
