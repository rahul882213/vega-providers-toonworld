import { EpisodeLink, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  enrichCinemetaEpisodes,
  getCinemetaMeta,
  readCinemetaContext,
} from "../getCinemetaMeta";
import { enrichEpisodesWithSkipTimings } from "../theintrodb";
import { fetchRogWithWAF } from "./posts";

export const getEpisodes = async function ({
  url,
  providerContext,
}: {
  url: string;
  providerContext: ProviderContext;
}): Promise<EpisodeLink[]> {
  const { cheerio } = providerContext;
  console.log("getEpisodeLinks", url);
  try {
    const context = readCinemetaContext(url);
    const res = await fetchRogWithWAF(context.requestUrl, providerContext);
    const $ = cheerio.load(res.data);
    const container = $(".entry-content,.entry-inner,body").first();
    $(".unili-content,.code-block-1").remove();
    const episodes: EpisodeLink[] = [];

    container.find("h3, h4, h5, p").each((index, element) => {
      const el = $(element);
      const text = el.text().trim();
      if (
        /episodes?\s*[:\d\-]/i.test(text) ||
        /e\d{1,3}\b/i.test(text) ||
        /^episode\s*\d+/i.test(text)
      ) {
        const title = text
          .replace(/\s+/g, " ")
          .trim()
          .replace(/^[-:\s]+|[-:\s]+$/g, "")
          .replace(/^episodes?\s*:\s*/i, "Episode ");

        let nextP = el.next();
        while (nextP.length && !nextP.is("p") && !nextP.find("a[href]").length) {
          nextP = nextP.next();
        }

        const vcloudLink = nextP
          .find("a[href*='vcloud'], a[href*='hubcloud']")
          .attr("href");
        const vegadriveLink = nextP.find("a[href*='vegadrive']").attr("href");
        let link = "";
        if (vcloudLink && vegadriveLink) {
          link = JSON.stringify({
            hubcloud: vcloudLink,
            vegadrive: vegadriveLink,
          });
        } else {
          link =
            vcloudLink ||
            vegadriveLink ||
            nextP.find("a[href*='fastdl']").attr("href") ||
            nextP.find(".btn-outline").parent().attr("href") ||
            nextP.find(".btn-outline").attr("href") ||
            nextP.find("a[href]").first().attr("href") ||
            "";
        }

        if (title && link && !episodes.some((e) => e.title === title)) {
          episodes.push({ title, link });
        }
      }
    });

    const quickDownload =
      await providerContext.kvStore?.get<boolean>("luxMovies_quickDownload");

    if (!context.imdbId || !context.season) {
      return episodes.map((e) => ({
        ...e,
        quickDownload: quickDownload ?? true,
      }));
    }

    let enriched = episodes;
    try {
      const cinemeta = await getCinemetaMeta(
        context.imdbId,
        "series",
        providerContext,
      );
      if (cinemeta) {
        enriched = enrichCinemetaEpisodes(
          episodes,
          cinemeta.videos || [],
          context.season,
        );
      }
    } catch (e) {
      console.warn("LuxMovies: Cinemeta episode lookup failed", e);
    }

    const skipTimings =
      await providerContext.kvStore?.get<boolean>("luxMovies_skipTimings");
    if (skipTimings ?? true) {
      try {
        enriched = await enrichEpisodesWithSkipTimings(
          enriched,
          context.imdbId,
          context.season,
          providerContext,
        );
      } catch (e) {
        console.warn("LuxMovies: Skip timings lookup failed", e);
      }
    }

    return enriched.map((e) => ({
      ...e,
      quickDownload: quickDownload ?? true,
    }));
  } catch (err) {
    throwProviderError("LuxMovies", "episodes", err);
  }
};
