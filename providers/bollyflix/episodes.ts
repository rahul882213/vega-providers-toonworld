import { EpisodeLink, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";

const defaultHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
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
    const res = await axios.get(url, {
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: "https://bollyflix.church/",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(res.data);
    const episodes: EpisodeLink[] = [];

    // Parse all links that denote episodes
    $("a").each((_: number, el: any) => {
      const text = $(el).text().trim();
      const href = $(el).attr("href") || "";

      if (!href || href.startsWith("#") || href.includes("javascript:")) return;

      const epMatch =
        text.match(/episode\s*0*(\d+)/i) ||
        text.match(/\be\s*0*(\d+)\b/i) ||
        href.match(/episode[-_.]?0*(\d+)/i);

      if (epMatch || (/fastdl|linksmod|drive|download/i.test(href) && /ep|episode/i.test(text))) {
        const epNum = epMatch ? epMatch[1] : `${episodes.length + 1}`;
        const cleanTitle = `Episode ${epNum.padStart(2, "0")}`;

        if (!episodes.some((e) => e.link === href)) {
          episodes.push({
            title: cleanTitle,
            link: href,
          });
        }
      }
    });

    // Fallback: If no links with "Episode" text were found, collect all candidate download links
    if (episodes.length === 0) {
      $("a").each((_: number, el: any) => {
        const text = $(el).text().trim();
        const href = $(el).attr("href") || "";
        if (
          href &&
          !href.startsWith("#") &&
          (href.includes("fastdl") || href.includes("linksmod") || href.includes("drive"))
        ) {
          episodes.push({
            title: text || `Episode ${episodes.length + 1}`,
            link: href,
          });
        }
      });
    }

    return episodes;
  } catch (err: any) {
    return throwProviderError("bollyflix", "getEpisodes", err);
  }
};
