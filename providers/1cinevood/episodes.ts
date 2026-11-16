import { EpisodeLink, ProviderContext } from "../types";
import {
  enrichCinemetaEpisodes,
  formatEpisodeTitle as formatCinemetaEpisodeTitle,
  getCinemetaMeta,
  readCinemetaContext,
} from "../getCinemetaMeta";
import { enrichEpisodesWithSkipTimings } from "../theintrodb";
import { getWithWAF, normalizeCinewoodLink } from "./helper";

const formatEpisodeTitle = (fileName: string): string => {
  try {
    const match = fileName.match(/S(\d+)E(\d+)/i);
    if (match) {
      const season = match[1].padStart(2, "0");
      const episode = match[2].padStart(2, "0");
      return `S${season} E${episode}`;
    }
    return fileName;
  } catch {
    return fileName;
  }
};

function parseHtmlEpisodes($: any, requestUrl: string): EpisodeLink[] {
  const episodes: EpisodeLink[] = [];
  const container = $(".entry-content, .entry-inner, .post-inner, body").first();
  $(".unili-content, .code-block-1").remove();

  container.find("h2, h3, h4, h5, p").each((_: number, element: any) => {
    const el = $(element);
    const text = el.text().replace(/\s+/g, " ").trim();

    if (
      /episodes?\s*[:\d\-]/i.test(text) ||
      /\bS\d{1,2}\s*E\d{1,3}\b/i.test(text) ||
      /\bE\d{1,3}\b/i.test(text) ||
      /^episode\s*\d+/i.test(text)
    ) {
      const epNumMatch =
        text.match(/\b(?:episode|ep)\s*[:.\-]*\s*(\d{1,3})\b/i) ||
        text.match(/\bE(\d{1,3})\b/i);
      const title = epNumMatch
        ? `Episode ${epNumMatch[1].padStart(2, "0")}`
        : text
            .replace(/^[-:\s]+|[-:\s]+$/g, "")
            .replace(/^episodes?\s*:\s*/i, "Episode ");

      let nextP = el.next();
      while (nextP.length && !nextP.is("hr") && !nextP.find("a[href]").length) {
        nextP = nextP.next();
      }
      const candidateScope =
        nextP.length && nextP.find("a[href]").length ? nextP : el;

      const link =
        candidateScope
          .find("a[href*='zee-dl'], a[href*='fastdl'], a:contains('G-Direct')")
          .attr("href") ||
        candidateScope
          .find("a[href*='vegadrive'], a:contains('V-Drive'), a[href*='gdflix']")
          .attr("href") ||
        candidateScope.find("a[href*='vcloud'], a[href*='hubcloud']").attr("href") ||
        candidateScope
          .find("a:contains('M-Cloud'), a:contains('V-Cloud'), a:contains('Zee-Cloud')")
          .attr("href") ||
        candidateScope.find(".btn-outline").parent().attr("href") ||
        candidateScope.find(".btn-outline").attr("href") ||
        candidateScope.find("a[href]").first().attr("href");

      if (title && link && !episodes.some((e) => e.title === title)) {
        episodes.push({
          title,
          link: normalizeCinewoodLink(new URL(link, requestUrl).href),
        });
      }
    }
  });

  if (episodes.length === 0) {
    $("a[href]").each((_: number, a: any) => {
      const text = $(a).text().replace(/\s+/g, " ").trim();
      const href = $(a).attr("href") || "";
      if (!href || href === "#" || href.startsWith("javascript:")) return;
      const epMatch =
        text.match(/\b(?:episode|ep)\s*0*(\d{1,3})\b/i) ||
        text.match(/\bE0*(\d{1,3})\b/i);
      if (epMatch) {
        const title = `Episode ${epMatch[1].padStart(2, "0")}`;
        const absHref = normalizeCinewoodLink(new URL(href, requestUrl).href);
        if (!episodes.some((e) => e.title === title || e.link === absHref)) {
          episodes.push({ title, link: absHref });
        }
      }
    });
  }

  // If the page is a single-pack genxfm/nexdrive page with G-Direct / V-Drive / V-Cloud buttons,
  // keep requestUrl as Episode 01 so getStream can extract G-Direct & V-Drive directly!
  if (episodes.length === 0) {
    const hasPackButtons =
      $(
        "a[href*='zee-dl'], a:contains('G-Direct'), a[href*='vegadrive'], a:contains('V-Drive'), a[href*='vcloud'], a[href*='hubcloud'], a[href*='gdflix']",
      ).length > 0;
    if (hasPackButtons) {
      episodes.push({
        title: "Episode 01",
        link: normalizeCinewoodLink(requestUrl),
      });
    }
  }

  return episodes;
}

export const getEpisodes = async function ({
  url,
  providerContext,
}: {
  url: string;
  providerContext: ProviderContext;
}): Promise<EpisodeLink[]> {
  const {
    axios,
    cheerio,
    commonHeaders: headers,
    openWebView,
  } = providerContext;
  console.log("getEpisodeLinks", url);
  try {
    const context = readCinemetaContext(url);
    const requestUrl = normalizeCinewoodLink(context.requestUrl);
    const parsedUrl = new URL(requestUrl);
    const baseUrl = parsedUrl.origin;
    const id = parsedUrl.pathname.split("/").filter(Boolean).pop() || "";

    const attachEpisodeContext = (epLink: string, epNum?: number): string => {
      const normalizedEpLink = normalizeCinewoodLink(epLink);
      if (!context.imdbId) return normalizedEpLink;
      try {
        const u = new URL(normalizedEpLink);
        const params = new URLSearchParams(u.hash.replace(/^#/, ""));
        params.set(
          "cinemetaMeta",
          JSON.stringify({
            imdbId: context.imdbId,
            season: context.season || 1,
            episode: epNum || 1,
            type: "series",
          }),
        );
        u.hash = params.toString();
        return u.href;
      } catch {
        return normalizedEpLink;
      }
    };

    const buildCinemetaFallbackEpisodes = async (): Promise<EpisodeLink[]> => {
      if (!context.imdbId) return [];
      try {
        const cinemeta = await getCinemetaMeta(
          context.imdbId,
          "series",
          providerContext,
        );
        const targetSeason = context.season || 1;
        const seasonVideos = (cinemeta?.videos || []).filter(
          (v) => v.season === targetSeason && (v.episode ?? v.number),
        );
        if (seasonVideos.length > 0) {
          return seasonVideos.map((v) => {
            const epNum = Number(v.episode ?? v.number ?? 1);
            return {
              title: formatCinemetaEpisodeTitle(epNum, v.name),
              link: attachEpisodeContext(requestUrl, epNum),
              image: v.thumbnail,
              description: v.description || v.overview,
            };
          });
        }
      } catch {}
      return [
        {
          title: "Episode 01",
          link: attachEpisodeContext(requestUrl, 1),
        },
      ];
    };

    const enrich = async (episodes: EpisodeLink[]): Promise<EpisodeLink[]> => {
      const quickDownload =
        await providerContext.kvStore?.get<boolean>("1cinevood_quickDownload");

      const withContext = episodes.map((e, idx) => {
        const epMatch = e.title.match(/(\d+)/);
        const epNum = epMatch ? Number(epMatch[1]) : idx + 1;
        return {
          ...e,
          link: attachEpisodeContext(e.link, epNum),
        };
      });

      if (!context.imdbId || !context.season) {
        return withContext.map((e) => ({
          ...e,
          quickDownload: quickDownload ?? true,
        }));
      }

      let enriched = withContext;

      try {
        const cinemeta = await getCinemetaMeta(
          context.imdbId,
          "series",
          providerContext,
        );
        if (cinemeta) {
          enriched = enrichCinemetaEpisodes(
            withContext,
            cinemeta.videos || [],
            context.season,
          );
        }
      } catch (e) {
        console.warn("1CineVood: Cinemeta episode lookup failed", e);
      }

      const skipTimings =
        await providerContext.kvStore?.get<boolean>("1cinevood_skipTimings");
      if (skipTimings ?? true) {
        try {
          enriched = await enrichEpisodesWithSkipTimings(
            enriched,
            context.imdbId,
            context.season,
            providerContext,
          );
        } catch (e) {
          console.warn("1CineVood: Skip timings lookup failed", e);
        }
      }

      return enriched.map((e) => ({
        ...e,
        quickDownload: quickDownload ?? true,
      }));
    };

    // 1. If the link is a nexdrive/genxfm/mobilejsr/dotlink page (not oxxfile), fetch HTML directly first
    if (!requestUrl.includes("oxxfile")) {
      try {
        const pageRes = await getWithWAF(
          requestUrl,
          axios,
          openWebView,
          headers,
        );
        const rawData = pageRes?.data;
        if (typeof rawData === "string" && rawData.includes("<")) {
          const $ = cheerio.load(rawData);
          const htmlEpisodes = parseHtmlEpisodes($, requestUrl);
          if (htmlEpisodes.length > 0) {
            return await enrich(htmlEpisodes);
          }
        }
      } catch (htmlErr: any) {
        if (context.imdbId) {
          const fallbackEps = await buildCinemetaFallbackEpisodes();
          if (fallbackEps.length > 0) {
            return await enrich(fallbackEps);
          }
        }
        return [
          {
            title: "Episode 01",
            link: attachEpisodeContext(requestUrl, 1),
          },
        ];
      }
    }

    // 2. Try oxxfile /api/packs/${id} JSON API
    const apiUrl = `${baseUrl}/api/packs/${id}`;
    let res;
    try {
      res = await getWithWAF(apiUrl, axios, openWebView, headers);
    } catch (error: any) {
      if (error.response?.status === 404) {
        const alternativeUrl = `${baseUrl}/api/s/${id}/`;
        const altRes = await getWithWAF(
          alternativeUrl,
          axios,
          openWebView,
          headers,
        );

        let altData = altRes?.data;
        if (typeof altData === "string") {
          try {
            altData = JSON.parse(altData.replace(/<[^>]+>/g, "").trim());
          } catch {}
        }

        if (altData?.hasHubcloud) {
          const hubcloudUrl = `${baseUrl}/api/s/${id}/hubcloud`;
          return enrich([
            {
              title: formatEpisodeTitle(altData.fileName || "Movie"),
              link: hubcloudUrl,
            },
          ]);
        }
        return [];
      }
      if (context.imdbId) {
        const fallbackEps = await buildCinemetaFallbackEpisodes();
        if (fallbackEps.length > 0) {
          return await enrich(fallbackEps);
        }
      }
      throw error;
    }

    const episodes: EpisodeLink[] = [];
    let packData = res?.data;
    if (typeof packData === "string") {
      if (packData.includes("<html") || packData.includes("entry-content")) {
        const $ = cheerio.load(packData);
        const htmlEpisodes = parseHtmlEpisodes($, requestUrl);
        if (htmlEpisodes.length > 0) {
          return await enrich(htmlEpisodes);
        }
      }
      try {
        packData = JSON.parse(packData.replace(/<[^>]+>/g, "").trim());
      } catch {}
    }

    const items = packData?.pack?.items || [];
    for (const item of items) {
      if (item.file_name && item.hubcloud_link) {
        episodes.push({
          title: formatEpisodeTitle(item.file_name),
          link: item.hubcloud_link,
        });
      }
    }

    return await enrich(episodes);
  } catch (err) {
    throw err;
  }
};
