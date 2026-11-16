import { EpisodeLink, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  enrichCinemetaEpisodes,
  getCinemetaMeta,
  readCinemetaContext,
} from "../getCinemetaMeta";
import { enrichEpisodesWithSkipTimings } from "../theintrodb";
import { fetchRogWithWAF, normalizeRogLockerUrl } from "./posts";

export const getEpisodes = async function ({
  url,
  providerContext,
}: {
  url: string;
  providerContext: ProviderContext;
}): Promise<EpisodeLink[]> {
  const { cheerio } = providerContext;
  try {
    const context = readCinemetaContext(url);
    const reqUrl = normalizeRogLockerUrl(context.requestUrl);
    const res = await fetchRogWithWAF(reqUrl, providerContext);
    const $ = cheerio.load(res.data);
    const container = $(
      ".single-service-contents, .entry-content, .entry-inner, body",
    ).first();
    $(".unili-content,.code-block-1").remove();

    const episodes: EpisodeLink[] = [];
    container.find("h3, h4, h5, p").each((_, element) => {
      const el = $(element);
      const text = el.text().trim();
      if (
        /episodes?\s*[:\d\-]/i.test(text) ||
        /\be\d{1,3}\b/i.test(text) ||
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
          .find("a[href*='vcloud'], a[href*='zcloud'], a[href*='hubcloud']")
          .attr("href");
        const vegadriveLink = nextP.find("a[href*='vegadrive']").attr("href");
        const gDirectLink = nextP
          .find("a[href*='zee-dl'], a[href*='fastdl'], a:contains('G-Direct')")
          .attr("href");
        const gdflixLink = nextP.find("a[href*='gdflix']").attr("href");

        let link = "";
        if (vcloudLink && vegadriveLink) {
          link = JSON.stringify({
            hubcloud: normalizeRogLockerUrl(vcloudLink),
            vegadrive: vegadriveLink,
          });
        } else {
          link =
            vegadriveLink ||
            gDirectLink ||
            vcloudLink ||
            gdflixLink ||
            nextP.find(".btn-outline").parent().attr("href") ||
            nextP.find(".btn-outline").attr("href") ||
            nextP.find("a[href]").first().attr("href") ||
            "";
        }
        if (title && link) {
          const finalLink = link.startsWith("{") ? link : normalizeRogLockerUrl(link);
          if (!episodes.some((e) => e.title === title)) {
            episodes.push({ title, link: finalLink });
          }
        }
      }
    });

    if (episodes.length === 0) {
      const hasPackButtons =
        $(
          "a[href*='zee-dl'], a:contains('G-Direct'), a[href*='vegadrive'], a:contains('V-Drive'), a[href*='vcloud'], a[href*='zcloud'], a[href*='hubcloud'], a[href*='gdflix']",
        ).length > 0;
      if (hasPackButtons) {
        episodes.push({
          title: "Episode 01",
          link: reqUrl,
        });
      }
    }

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
