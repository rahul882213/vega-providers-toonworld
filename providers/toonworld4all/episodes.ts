import { EpisodeLink, ProviderContext } from "../types";

export const getEpisodes = async ({
  url,
  providerContext,
}: {
  url: string;
  signal?: AbortSignal;
  providerContext: ProviderContext;
}): Promise<EpisodeLink[]> => {
  const { axios, cheerio, commonHeaders = {} } = providerContext;
  const headers = {
    Referer: "https://toonworld4all.me/",
    ...commonHeaders,
  };

  const res = await axios.get(url, { headers });
  const html = res.data || "";
  const $ = cheerio.load(html);
  const episodes: EpisodeLink[] = [];

  $(".mks_accordion_item").each((i: number, el: any) => {
    const item = $(el);
    const heading = item.find(".mks_accordion_heading").text().trim();
    const link = item
      .find('a.mks_button, a[href*="archive.toonworld4all.me"]')
      .first()
      .attr("href");

    if (!link) return;

    const epMatch = heading.match(/(?:Episode|Ep\.?)\s*(\d+)/i);
    const episode = epMatch ? parseInt(epMatch[1], 10) : i + 1;

    episodes.push({
      title:
        heading.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() ||
        `Episode ${episode}`,
      link,
    });
  });

  return episodes;
};
