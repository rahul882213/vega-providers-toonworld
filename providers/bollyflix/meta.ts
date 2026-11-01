import { Info, Link, ProviderContext } from "../types";
import { getBollyflixBaseUrl } from "./posts";
import { throwProviderError } from "../providerErrors";
import { applyCinemetaMeta, getCinemetaMeta } from "../getCinemetaMeta";

const defaultHeaders = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export const getMeta = async function ({
  link,
  providerContext,
}: {
  link: string;
  providerContext: ProviderContext;
}): Promise<Info> {
  const { axios, cheerio, commonHeaders } = providerContext;
  const baseUrl = await getBollyflixBaseUrl(providerContext);

  const targetUrl = link.startsWith("http")
    ? link
    : new URL(link, baseUrl).href;

  try {
    const res = await axios.get(targetUrl, {
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: baseUrl + "/",
      },
      timeout: 15000,
    });

    const $ = cheerio.load(res.data);

    // 1. Title Extraction & Cleanup
    const rawH1 = $("h1").first().text().trim() || $("title").text().trim();
    let cleanTitle = rawH1
      .replace(/^Download\s+/i, "")
      .replace(/\s*(?:480p|720p|1080p|2160p|4k|HDTC|WEB-DL|BluRay|ESub|HC-ESub|CAMRip|UNCUT|Dual Audio|Multi Audio).*/i, "")
      .replace(/\s*\{.*?\}\s*/g, " ")
      .replace(/\s*\[.*?\]\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleanTitle) {
      cleanTitle = rawH1.replace(/^Download\s+/i, "").trim();
    }

    // 2. Type Detection
    const isSeries =
      /season|s\d+|series|episodes/i.test(rawH1) ||
      /season|series|episode/i.test(targetUrl);
    const mediaType = isSeries ? "series" : "movie";

    // 3. Synopsis Extraction
    let synopsis = "";
    $("p").each((_: number, el: any) => {
      const text = $(el).text().trim();
      if (
        (text.toLowerCase().includes("storyline") ||
          text.toLowerCase().includes("synopsis") ||
          text.toLowerCase().includes("plot")) &&
        !synopsis
      ) {
        synopsis = text.replace(/^(?:storyline|synopsis|plot)\s*:?\s*/i, "").trim();
      }
    });

    if (!synopsis) {
      synopsis =
        $("meta[property='og:description']").attr("content") ||
        $("meta[name='description']").attr("content") ||
        "";
    }

    // 4. Image Extraction
    const image =
      $("meta[property='og:image']").attr("content") ||
      $("article img, .post-image img, .entry-content img").first().attr("src") ||
      "";

    // 5. IMDb ID Extraction
    let imdbId = "";
    const imdbMatch =
      res.data.match(/imdb\.com\/title\/(tt\d{7,9})/i) ||
      res.data.match(/\b(tt\d{7,9})\b/i);
    if (imdbMatch) {
      imdbId = imdbMatch[1];
    }

    // 6. Build LinkList
    const linkList: Link[] = [];

    if (isSeries) {
      // Dynamic Series: Find season/resolution blocks pointing to fxlinks or episode lists
      $("a").each((_: number, el: any) => {
        const href = $(el).attr("href") || "";
        const text = $(el).text().trim();
        const cls = $(el).attr("class") || "";

        if (
          href.includes("fxlinks") ||
          (cls.includes("maxbutton") && /download/i.test(text)) ||
          /elinks|episodes/i.test(href)
        ) {
          const parentP = $(el).parent();
          const prevText =
            parentP.prev().text().replace(/\s+/g, " ").trim() ||
            parentP.text().replace(/\s+/g, " ").trim();

          const seasonMatch =
            prevText.match(/season\s*(\d+)/i) || rawH1.match(/season\s*(\d+)/i);
          const sNum = seasonMatch ? seasonMatch[1] : "1";

          const qualMatch = prevText.match(/(480p|720p|1080p|2160p)/i);
          const qual = qualMatch ? qualMatch[1] : "";
          const codecMatch = prevText.match(/10bit|hevc/i);
          const codec = codecMatch ? ` [${codecMatch[0]}]` : "";

          const seasonTitle = `Season ${sNum}${qual ? ` (${qual}${codec})` : ""}`;

          // Avoid duplicate season links
          if (!linkList.some((l) => l.episodesLink === href)) {
            linkList.push({
              title: seasonTitle,
              quality: qual ? qual.replace("p", "") : undefined,
              episodesLink: href,
            });
          }
        }
      });

      // Fallback: If no fxlinks were found, search for direct episode buttons on the page
      if (linkList.length === 0) {
        const directEps: { title: string; link: string; type: "series" }[] = [];
        $("a").each((_: number, el: any) => {
          const href = $(el).attr("href") || "";
          const text = $(el).text().trim();
          if (
            /episode\s*\d+/i.test(text) ||
            /ep\s*\d+/i.test(text) ||
            /e\d+/i.test(text)
          ) {
            directEps.push({
              title: text,
              link: href,
              type: "series",
            });
          }
        });
        if (directEps.length > 0) {
          linkList.push({
            title: "Season 1",
            directLinks: directEps,
          });
        }
      }
    } else {
      // Movies: Group by resolution block
      $("a.dl, a.maxbutton, a[href*='fastdl'], a[href*='linksmod']").each(
        (_: number, el: any) => {
          const href = $(el).attr("href") || "";
          const text = $(el).text().trim() || "Download";

          if (
            !href ||
            href.includes("how-to-download") ||
            href.includes("/movies-by-") ||
            href.includes("/category/") ||
            href.startsWith("#")
          ) {
            return;
          }

          const parentP = $(el).parent();
          const prevText =
            parentP.prev().text().replace(/\s+/g, " ").trim() ||
            parentP.text().replace(/\s+/g, " ").trim();

          const qualMatch =
            prevText.match(/(480p|720p|1080p|2160p)/i) ||
            rawH1.match(/(480p|720p|1080p|2160p)/i);
          const qual = qualMatch ? qualMatch[1] : "720p";

          const sizeMatch = prevText.match(/\[([0-9.]+\s*(?:MB|GB))\]/i);
          const size = sizeMatch ? ` [${sizeMatch[1]}]` : "";

          const blockTitle = `${qual}${size}`;

          let group = linkList.find((l) => l.title === blockTitle);
          if (!group) {
            group = {
              title: blockTitle,
              quality: qual.replace("p", ""),
              directLinks: [],
            };
            linkList.push(group);
          }

          const isGdrive =
            /drive|fastdl|g-direct/i.test(text) || href.includes("fastdl");
          const dTitle = isGdrive
            ? "Google Drive (Fast Server)"
            : "Multi Links (LinksMod)";

          if (
            !group.directLinks?.some((dl) => dl.link === href)
          ) {
            group.directLinks = group.directLinks || [];
            group.directLinks.push({
              title: dTitle,
              link: href,
              type: "movie",
            });
          }
        },
      );

      // Fallback for movies if no grouped buttons were matched
      if (linkList.length === 0) {
        const fallbacks: { title: string; link: string; type: "movie" }[] = [];
        $("a").each((_: number, el: any) => {
          const href = $(el).attr("href") || "";
          const text = $(el).text().trim();
          if (
            (href.includes("fastdl") || href.includes("linksmod") || href.includes("drive")) &&
            !href.includes("/how-to-download/")
          ) {
            fallbacks.push({
              title: text || "Download Movie",
              link: href,
              type: "movie",
            });
          }
        });
        if (fallbacks.length > 0) {
          linkList.push({
            title: "Movie",
            quality: "720",
            directLinks: fallbacks,
          });
        }
      }
    }

    const baseInfo: Info = {
      title: cleanTitle,
      synopsis,
      image,
      imdbId,
      type: mediaType,
      linkList,
    };

    // 7. Cinemeta Enrichment if IMDb ID found
    if (imdbId) {
      try {
        const cinemeta = await getCinemetaMeta(imdbId, mediaType, providerContext);
        return applyCinemetaMeta(baseInfo, cinemeta);
      } catch {
        return baseInfo;
      }
    }

    return baseInfo;
  } catch (err: any) {
    return throwProviderError("bollyflix", "getMeta", err);
  }
};
