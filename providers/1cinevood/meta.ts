import { Info, Link, ProviderContext } from "../types";
import { throwProviderError } from "../providerErrors";
import {
  addCinemetaContext,
  applyCinemetaMeta,
  getCinemetaMeta,
  getCinemetaSeason,
} from "../getCinemetaMeta";
import { getCinewoodBaseUrl, getWithWAF } from "./helper";

const formatSeasonTag = (text: string): string => {
  const seMatch = text.match(/\b(S\d{1,2}\s*E\d{1,3}|S\d{1,2}|E\d{1,3})\b/i);
  if (seMatch) {
    return seMatch[1].toUpperCase().replace(/\s+/g, "");
  }
  const seasonNumMatch = text.match(/\bSeason\s*(\d{1,2})\b/i);
  if (seasonNumMatch) {
    return `S${seasonNumMatch[1].padStart(2, "0")}`;
  }
  return "";
};

const addStreamContextHash = (
  targetUrl: string,
  meta: { imdbId?: string; title?: string; type?: string; season?: number },
): string => {
  try {
    const parsed = new URL(targetUrl);
    const params = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    if (!params.get("cinemetaMeta") && meta.imdbId) {
      params.set(
        "cinemetaMeta",
        JSON.stringify({
          imdbId: meta.imdbId,
          season: meta.season || 1,
          title: meta.title || "",
          type: meta.type || "movie",
        }),
      );
      parsed.hash = params.toString();
    }
    return parsed.href;
  } catch {
    return targetUrl;
  }
};

export const getMeta = async function ({
  link,
  providerContext,
}: {
  link: string;
  providerContext: ProviderContext;
}): Promise<Info> {
  const { axios, cheerio, commonHeaders, openWebView } = providerContext;
  const baseUrl = await getCinewoodBaseUrl();
  const url = new URL(link, `${baseUrl}/`).href;

  try {
    const response = await getWithWAF(url, axios, openWebView, commonHeaders);
    const $ = cheerio.load(response.data);
    const infoContainer = $(
      ".entry-content, .post-inner, .post-single-content",
    ).first();
    const cleanText = (value?: string): string =>
      value ? $("<div>").html(value).text().replace(/\s+/g, " ").trim() : "";

    const schemaNodes: any[] = [];
    $('script[type="application/ld+json"]').each((_, script) => {
      try {
        const schema = JSON.parse($(script).html() || "");
        const roots = Array.isArray(schema) ? schema : [schema];
        roots.forEach((root) => {
          schemaNodes.push(root);
          if (Array.isArray(root?.["@graph"])) {
            schemaNodes.push(...root["@graph"]);
          }
        });
      } catch {
        // Ignore malformed schema blocks
      }
    });

    const hasSchemaType = (node: any, type: string): boolean => {
      const types = Array.isArray(node?.["@type"])
        ? node["@type"]
        : [node?.["@type"]];
      return types.some(
        (value: unknown) =>
          typeof value === "string" && value.toLowerCase() === type,
      );
    };

    const mediaSchema =
      schemaNodes.find((node) => hasSchemaType(node, "movie")) ||
      schemaNodes.find((node) => hasSchemaType(node, "tvseries")) ||
      schemaNodes.find((node) => hasSchemaType(node, "tvepisode"));

    const result: Info = {
      title: "",
      synopsis: "",
      image: "",
      imdbId: "",
      type: "movie",
      linkList: [],
    };

    const mfxInfoBoxText = cleanText($(".mfx-info-box").first().html() || undefined);
    const mfxInfoNameMatch = mfxInfoBoxText.match(
      /(?:Movie|Series)\s+Name:\s*(.+?)(?=\s+(?:Release|Released|Genres?|Runtime|Director|Cast|Language|Subtitle|Size|Quality|Format)\b|$)/i,
    );
    const mfxMainTitle = cleanText($(".mfx-main-title").first().text()).replace(
      /^Download\s+/i,
      "",
    );

    result.title =
      cleanText(mfxInfoNameMatch?.[1]) ||
      mfxMainTitle ||
      cleanText($(".cv-movie-title").first().text()) ||
      cleanText(mediaSchema?.name) ||
      cleanText($("#movie_title a").first().text()) ||
      cleanText($("meta[property='og:title']").attr("content"))
        .replace(/^Download\s+/i, "")
        .replace(/\s*[-|]\s*CineVood.*$/i, "") ||
      cleanText($("h1.entry-title, h1.single-title").first().text()).replace(
        /^Download\s+/i,
        "",
      ) ||
      cleanText($("title").first().text()).replace(/^Download\s+/i, "") ||
      "Unknown Title";

    // --- Type determination ---
    const firstDownloadHeadingText = infoContainer
      .find(".mfx-quality-title, h3, h5, h6")
      .first()
      .text();
    const mfxSectionTitle = $(".mfx-section-title").first().text();

    const isSeries =
      /\bS\d{1,2}(?:E\d{1,3})?\b/i.test(firstDownloadHeadingText) ||
      /\bE\d{1,3}\b/i.test(firstDownloadHeadingText) ||
      firstDownloadHeadingText.toLowerCase().includes("season") ||
      /\[\s*\d+(?:\.\d+)?\s*(?:MB|GB)\s*\/\s*E\s*\]/i.test(
        firstDownloadHeadingText,
      ) ||
      /series\s+info|series\s+name/i.test(
        `${mfxSectionTitle} ${mfxInfoBoxText}`,
      ) ||
      hasSchemaType(mediaSchema, "tvseries") ||
      hasSchemaType(mediaSchema, "tvepisode") ||
      /\b(?:series|season)\b/i.test($(".cv-card-download-info").first().text());
    result.type = isSeries ? "series" : "movie";

    // --- IMDb ID ---
    const imdbMatch =
      $(".mfx-imdb a[href*='imdb.com/title/tt'], a[href*='imdb.com/title/tt']")
        .first()
        .attr("href")
        ?.match(/tt\d+/) ||
      String(mediaSchema?.sameAs || mediaSchema?.url || "").match(/tt\d+/);
    result.imdbId = imdbMatch ? imdbMatch[0] : "";

    // --- Image ---
    const schemaImage =
      typeof mediaSchema?.image === "string"
        ? mediaSchema.image
        : mediaSchema?.image?.url || mediaSchema?.image?.contentUrl;

    let image =
      $(".cv-movie-poster-img, .mfx-poster img").first().attr("src") ||
      schemaImage ||
      $("meta[property='og:image']").attr("content") ||
      infoContainer.find('img[decoding="async"], img').first().attr("src") ||
      "";
    if (image.startsWith("//")) image = "https:" + image;
    result.image = image;

    // --- Synopsis ---
    result.synopsis =
      cleanText($(".mfx-plot-box").first().text()) ||
      cleanText(
        $(".cv-movie-overview-box")
          .first()
          .clone()
          .children()
          .remove()
          .end()
          .text(),
      ) ||
      cleanText(mediaSchema?.description) ||
      cleanText(
        infoContainer
          .find("#summary b:contains('Summary:')")
          .parent()
          .text()
          .replace("Summary:", ""),
      ) ||
      cleanText($("meta[property='og:description']").attr("content")) ||
      cleanText($("meta[name='description']").attr("content"));

    // --- LinkList extraction ---
    const links: Link[] = [];

    // 1. Modern .mfx-download-group blocks on one.1cinevood.baby
    const mfxGroups = infoContainer.find(".mfx-download-group");
    if (mfxGroups.length > 0) {
      mfxGroups.each((_, groupEl) => {
        const group = $(groupEl);
        const fullTitle = group
          .find(".mfx-quality-title, h3, h4, h5")
          .first()
          .text()
          .replace(/\s+/g, " ")
          .trim();
        const qualityMatch =
          fullTitle.match(/\b(\d{3,4}p)\b/i)?.[1] ||
          (fullTitle.toLowerCase().includes("4k") ? "2160p" : "");
        const fileSizeMatch =
          fullTitle.match(/\[([^\]]+)\](?=[^\[]*$)/)?.[1] || "";
        const seTag = formatSeasonTag(fullTitle);
        const seasonEpisode = seTag ? `${seTag} | ` : "";

        const displayTitle =
          `${seasonEpisode}${qualityMatch || fullTitle}${
            fileSizeMatch ? " | " + fileSizeMatch : ""
          }`
            .trim()
            .replace(/\|$/, "")
            .trim() || fullTitle;

        const anchors = group
          .find("a.mfx-download-link, .mfx-download-buttons a[href], a[href]")
          .filter((__, a) => {
            const href = $(a).attr("href") || "";
            return (
              Boolean(href) &&
              href !== "#" &&
              !href.startsWith("javascript:") &&
              /^https?:/i.test(href)
            );
          });

        if (anchors.length === 0) return;

        if (result.type === "series") {
          let chosenHref = "";
          anchors.each((__, a) => {
            const txt = $(a).text().toLowerCase();
            const href = $(a).attr("href") || "";
            if (
              !chosenHref &&
              !txt.includes("batch") &&
              !txt.includes("zip") &&
              /m-cloud|v-cloud|vcloud|hubcloud|resumable/i.test(
                `${txt} ${href}`,
              )
            ) {
              chosenHref = href;
            }
          });
          if (!chosenHref) {
            anchors.each((__, a) => {
              const txt = $(a).text().toLowerCase();
              const href = $(a).attr("href") || "";
              if (
                !chosenHref &&
                !txt.includes("batch") &&
                !txt.includes("zip")
              ) {
                chosenHref = href;
              }
            });
          }
          if (!chosenHref) {
            chosenHref = $(anchors[0]).attr("href") || "";
          }
          if (chosenHref) {
            links.push({
              title: displayTitle,
              quality: qualityMatch,
              episodesLink: chosenHref,
            });
          }
        } else {
          const directLinks: NonNullable<Link["directLinks"]> = [];
          anchors.each((__, a) => {
            const rawHref = $(a).attr("href") || "";
            const href = addStreamContextHash(rawHref, {
              imdbId: result.imdbId,
              title: result.title,
              type: "movie",
            });
            const btnText = $(a).text().replace(/\s+/g, " ").trim() || "Movie";
            if (href && !directLinks.some((d) => d.link === href)) {
              directLinks.push({
                link: href,
                title:
                  anchors.length > 1 && !/download\s+now/i.test(btnText)
                    ? btnText
                    : "Movie",
                type: "movie",
              });
            }
          });
          if (directLinks.length > 0) {
            links.push({
              title: displayTitle,
              quality: qualityMatch,
              directLinks,
            });
          }
        }
      });
    }

    // 2. Legacy h5, h6 quality blocks
    if (links.length === 0) {
      const qualityBlocks = infoContainer.find("h3,h4,h5,h6").filter((_, el) => {
        const text = $(el).text();
        return (
          !text.includes("Watch Online") &&
          !text.includes("What quality versions") &&
          /\b(?:\d{3,4}p|2160p|4k|S\d{1,2}|E\d{1,3})\b/i.test(text)
        );
      });

      qualityBlocks.each((_, element) => {
        const el = $(element);
        const fullTitle = el.text().trim();
        const qualityMatch = fullTitle.match(/\d{3,4}p\b/)?.[0] || "";
        const fileSizeMatch =
          fullTitle.match(/\[([^\]]+)\](?=[^\[]*$)/)?.[1] || "";

        const nextSiblings = el.nextUntil("h3, h4, h5, h6, hr");
        nextSiblings
          .find("a")
          .add(nextSiblings.filter("a"))
          .each((__, btn) => {
            const btnEl = $(btn);
            const linkHref = btnEl.attr("href");
            if (
              !linkHref ||
              linkHref === "#" ||
              linkHref.startsWith("javascript:") ||
              !/(?:oxxfile|hubcloud|mobilejsr|genxfm|vcloud|gdflix|fastdl)/i.test(
                linkHref,
              )
            ) {
              return;
            }

            const seTag = formatSeasonTag(fullTitle);
            const seasonEpisode = seTag ? `${seTag} | ` : "";

            links.push({
              title: `${seasonEpisode}${qualityMatch}${
                fileSizeMatch ? " | " + fileSizeMatch : ""
              }`
                .trim()
                .replace(/\|$/, "")
                .trim(),
              quality: qualityMatch,
              episodesLink: result.type === "series" ? linkHref : "",
              directLinks:
                result.type === "movie"
                  ? [
                      {
                        link: addStreamContextHash(linkHref, {
                          imdbId: result.imdbId,
                          title: result.title,
                          type: "movie",
                        }),
                        title: "Movie",
                        type: "movie",
                      },
                    ]
                  : undefined,
            });
          });
      });
    }

    if (result.type === "movie" && links.length === 0) {
      infoContainer
        .find(
          'a[href*="oxxfile"],a[href*="hubcloud"],a[href*="mobilejsr"],a[href*="genxfm"],a.mfx-download-link',
        )
        .each((_, anchor) => {
          const linkHref = $(anchor).attr("href");
          if (!linkHref) return;
          links.push({
            title: $(anchor).text().trim() || "Movie",
            directLinks: [
              {
                link: addStreamContextHash(linkHref, {
                  imdbId: result.imdbId,
                  title: result.title,
                  type: "movie",
                }),
                title: "Movie",
                type: "movie",
              },
            ],
          });
        });
    }

    result.linkList = links;
    result.webUrl = url;
    const quickDownload =
      await providerContext.kvStore?.get<boolean>("1cinevood_quickDownload");
    result.quickDownload = Boolean(quickDownload);

    const imdbId = result.imdbId;
    if (!imdbId) return result;

    let cinemeta;
    try {
      cinemeta = await getCinemetaMeta(imdbId, result.type, providerContext);
    } catch (error) {
      console.warn(
        `Cinemeta lookup failed for ${imdbId}; using scraped Cinewood metadata.`,
        error,
      );
      return result;
    }

    if (cinemeta) {
      if (result.type === "series" && cinemeta.type === "series") {
        result.linkList = result.linkList.map((item) => {
          if (!item.episodesLink) return item;
          const season = getCinemetaSeason(item.title) || 1;
          return {
            ...item,
            episodesLink: addCinemetaContext(
              new URL(item.episodesLink, url).href,
              imdbId,
              season,
            ),
          };
        });
      }
      return applyCinemetaMeta(result, cinemeta);
    }

    return result;
  } catch (err) {
    throwProviderError("1CineVood", "metadata", err);
  }
};
