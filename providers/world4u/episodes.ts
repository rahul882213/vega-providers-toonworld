import { EpisodeLink, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import { attachW4uMeta, readW4uMeta } from "./meta";
import { extractWorld4uImgAttr, getWorld4uBaseUrl } from "./posts";

const defaultHeaders: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export const getEpisodes = async function ({
  url,
  providerContext,
}: {
  url: string;
  providerContext: ProviderContext;
}): Promise<EpisodeLink[]> {
  const { axios, cheerio, commonHeaders } = providerContext;
  try {
    const baseUrl = await getWorld4uBaseUrl();
    const { requestUrl, meta } = readW4uMeta(url);
    const fullUrl = new URL(requestUrl, `${baseUrl}/`).href;

    const res = await axios.get(fullUrl, {
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: `${baseUrl}/`,
      },
    });
    const html = res.data;
    const $ = cheerio.load(html);
    const episodeLinks: EpisodeLink[] = [];

    // 1. Modern Zetaflix episodes list (ul.episodes-list)
    const targetSeason = meta.season || 1;
    const seasonListSelector = $(`#season-listep-${targetSeason} li`).length
      ? `#season-listep-${targetSeason} li`
      : "ul.episodes-list li";

    $(seasonListSelector).each((idx, liEl) => {
      const li = $(liEl);
      const rawHref = li.find("a[href]").first().attr("href") || "";
      if (!rawHref) return;

      const epNum = Number(
        li.find(".ep-num").first().text().trim() ||
          rawHref.match(/(\d+)x(\d+)\/?$/i)?.[2] ||
          idx + 1,
      );
      const epName = li.find(".ep-title").first().text().trim();
      const thumb = extractWorld4uImgAttr(li.find(".ep-thumb img").first(), baseUrl) || undefined;

      const title = epName
        ? `Episode ${String(epNum).padStart(2, "0")} - ${epName}`
        : `Episode ${String(epNum).padStart(2, "0")}`;

      const absHref = new URL(rawHref, `${baseUrl}/`).href;
      const linkWithMeta = attachW4uMeta(absHref, {
        ...meta,
        season: targetSeason,
        episode: epNum,
        type: "series",
      });

      episodeLinks.push({
        title,
        link: linkWithMeta,
        image: thumb,
      });
    });

    if (episodeLinks.length > 0) {
      return episodeLinks;
    }

    // 2. Legacy World4u episode headings fallback
    $(
      'strong:contains("Episode"),strong:contains("1080"),strong:contains("720"),strong:contains("480")',
    ).each((_, element) => {
      const title = $(element).text().trim();
      const link = $(element)
        .parent()
        .parent()
        .next("h4")
        .find("a")
        .attr("href");
      if (link && !title.toLowerCase().includes("zip")) {
        episodeLinks.push({
          title,
          link,
        });
      }
    });

    return episodeLinks;
  } catch (err) {
    throwProviderError("World4u", "episodes", err);
  }
};
