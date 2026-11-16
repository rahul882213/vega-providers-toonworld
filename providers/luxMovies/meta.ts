import { formatSeasonLinks } from "../formatSeasonLinks";
import { Info, Link, ProviderContext } from "../types";
import {
  addCinemetaContext,
  applyCinemetaMeta,
  getCinemetaMeta,
  getCinemetaSeason,
} from "../getCinemetaMeta";
import {
  cleanPosterUrl,
  fetchRogWithWAF,
  getRogMoviesBaseUrl,
  normalizeRogLockerUrl,
} from "./posts";

export const getMeta = async ({
  link,
  providerContext,
}: {
  link: string;
  providerContext: ProviderContext;
}): Promise<Info> => {
  try {
    const { cheerio } = providerContext;
    const currentBaseUrl = await getRogMoviesBaseUrl();
    const url = new URL(link, `${currentBaseUrl}/`).href;
    const response = await fetchRogWithWAF(url, providerContext);
    const effectiveBase =
      response.resolvedUrl?.split("/").slice(0, 3).join("/") || currentBaseUrl;
    const $ = cheerio.load(response.data);
    const infoContainer = $(
      ".single-service-contents, .single-blog-left, .entry-content, .post-inner, .post-content, .page-body",
    );

    const cleanPageTitle = (raw: string): string =>
      raw
        .replace(/^Download\s+/i, "")
        .replace(/\s*[–\-|]\s*(?:Zeefliz|RogMovies|Vegamovies|1CineVood).*$/i, "")
        .trim();

    // title
    let title = "";
    const heading = infoContainer?.find("h3, p");
    const infoNameMatch = infoContainer
      .text()
      .match(/(?:Movie|Series)\s+Name:\s*([^\n\r]+)/i);
    if (infoNameMatch?.[1]) {
      title = infoNameMatch[1]
        .replace(/\b(?:Season|IMDb|Language|Released|Release|Genre|Size|Quality).*$/i, "")
        .trim();
    }
    if (!title) {
      const h1Title = $("h1.post-title, h1.entry-title, .mfx-main-title")
        .first()
        .text()
        .trim();
      if (h1Title && !/bonus|episodes?|download/i.test(h1Title)) {
        title = cleanPageTitle(h1Title);
      }
    }
    if (!title) {
      const htmlTitle =
        $("meta[property='og:title']").attr("content") ||
        $("title").first().text() ||
        heading?.next("p")?.text()?.match(/Name:\s*(.+)/)?.[1] ||
        "";
      title = cleanPageTitle(htmlTitle);
    }

    // imdbId
    let imdbId =
      $('a[href*="imdb.com/title/tt"]').attr("href")?.match(/tt\d+/)?.[0] || "";
    if (!imdbId) {
      imdbId =
        infoContainer.text().match(/tt\d{6,9}/g)?.[0] ||
        $("body").text().match(/tt\d{6,9}/)?.[0] ||
        "";
    }

    // type
    let type = "movie";
    const fullPageText = `${title} ${$("title").text()} ${infoContainer.text()}`;
    if (
      /Series\s+Name:/i.test(fullPageText) ||
      /\b(?:web\s*series|tv[\s-]*show|season\s*\d{1,2}|s\d{1,2}\s*e\d{1,3}|s\d{1,2}e\d{1,3})\b/i.test(
        fullPageText,
      )
    ) {
      type = "series";
    }

    // synopsis
    let synopsis = "";
    const synopsisHeader = $("h3, h2, h4").filter(
      (_, el) =>
        $(el).text().includes("SYNOPSIS/PLOT") ||
        $(el).text().includes("Plot") ||
        $(el).text().includes("Storyline"),
    );
    if (synopsisHeader.length > 0) {
      synopsis = synopsisHeader.next("p, div").text().trim();
    }
    if (!synopsis) {
      synopsis = $(".mfx-plot-box").first().text().trim();
    }
    if (!synopsis) {
      synopsis = $("meta[property='og:description']").attr("content")?.trim() || "";
    }

    // image (prioritize data-lazy-src / data-src / data-original over base64 SVG src placeholders)
    let image = "";
    const imgCandidates = $(
      ".single-blog-left img, .mfx-poster img, .poster img, .entry-content img, .single-service-contents img, .post-inner img",
    );
    imgCandidates.each((_, el) => {
      if (image) return;
      const $img = $(el);
      const srcs = [
        $img.attr("data-lazy-src"),
        $img.attr("data-src"),
        $img.attr("data-original"),
        $img.attr("src"),
      ];
      for (const s of srcs) {
        const cleaned = cleanPosterUrl(s, effectiveBase);
        if (
          cleaned &&
          !/logo|svg|placeholder|icon|favicon|screenshot/i.test(cleaned)
        ) {
          image = cleaned;
          return;
        }
      }
    });
    if (!image) {
      image = cleanPosterUrl(
        $("meta[property='og:image']").attr("content"),
        effectiveBase,
      );
    }

    const links: Link[] = [];

    // 1. Modern .mfx-download-group blocks (when served via 1cinevood mirror)
    const mfxGroups = $(".mfx-download-group");
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
        const anchors = group.find("a[href]").filter((__, a) => {
          const href = $(a).attr("href") || "";
          return Boolean(href) && href !== "#" && /^https?:/i.test(href);
        });
        if (anchors.length === 0) return;

        let chosenHref = "";
        if (type === "series") {
          anchors.each((__, a) => {
            const txt = $(a).text().toLowerCase();
            const href = $(a).attr("href") || "";
            if (!chosenHref && !txt.includes("batch") && !txt.includes("zip")) {
              chosenHref = href;
            }
          });
        }
        if (!chosenHref) {
          chosenHref = $(anchors[0]).attr("href") || "";
        }
        const normalizedHref = normalizeRogLockerUrl(chosenHref);
        if (!normalizedHref) return;

        if (type === "series") {
          links.push({
            title: fullTitle || "Season",
            episodesLink: normalizedHref,
            quality: qualityMatch,
          });
        } else {
          links.push({
            title: fullTitle || "Movie",
            directLinks: [{ title: "Movie", link: normalizedHref, type: "movie" }],
            quality: qualityMatch,
          });
        }
      });
    }

    // 2. Classic / Zeefliz-2026 heading + download paragraph layout
    if (links.length === 0) {
      let hr = infoContainer.first().find("hr").first();
      const firstButton = $(
        ".dwd-button, a[href*='nexdrive'], a[href*='genxfm'], a[href*='vcloud'], a[href*='fastdl'], a[href*='hubcloud'], a[href*='mobilejsr']",
      ).first();
      if (firstButton.length > 0) {
        const containerP = firstButton.closest("p, div");
        let prev = containerP.prev();
        while (prev.length && !prev.is("hr")) {
          prev = prev.prev();
        }
        if (prev.is("hr")) {
          hr = prev;
        }
      }

      const list = hr.length
        ? hr.nextAll()
        : infoContainer.length
          ? infoContainer.find("h1, h2, h3, h4, h5, h6, p")
          : $("body").find("h1, h2, h3, h4, h5, h6, p");

      list.each((_, element: any) => {
        const el = $(element);
        if (el.is("hr") || el.is("style") || el.is("script")) return;
        if (el.find("a[href]").length > 0) return;
        if (
          !el.is("h1, h2, h3, h4, h5, h6") &&
          !(el.is("p") && el.find("strong").length > 0)
        ) {
          return;
        }

        let itemTitle = el.text().replace(/\s+/g, " ").trim();
        const lower = itemTitle.toLowerCase();
        if (
          !itemTitle ||
          /^[\s\-_=~*•–—:|]+$/.test(itemTitle) ||
          lower.includes("synopsis") ||
          lower.includes("plot") ||
          lower.includes("screenshot") ||
          lower.includes("movie info") ||
          lower.includes("series info") ||
          lower.includes("download links") ||
          lower.includes("winding up") ||
          lower.includes("thank you") ||
          lower.includes("telegram") ||
          lower.includes("how to download") ||
          lower.includes("join our") ||
          lower === "download now"
        ) {
          return;
        }

        const quality = itemTitle.match(/\d+p\b/i)?.[0] || "";
        if (
          !quality &&
          !/episodes?\s*[:\d\-]/i.test(itemTitle) &&
          !/\[.*(?:mb|gb|e).*\]/i.test(itemTitle)
        ) {
          const nextEl = el.next();
          if (
            nextEl.length &&
            (nextEl.is("h1, h2, h3, h4, h5, h6, strong") ||
              (nextEl.is("p") && nextEl.find("strong").length))
          ) {
            return;
          }
        }

        itemTitle = itemTitle
          .replace(/^[\s•\-*—_:=~|]+|[\s•\-*—_:=~|]+$/g, "")
          .trim();
        if (!itemTitle) return;

        let nextP = el.next();
        while (nextP.length && !nextP.is("hr") && !nextP.find("a[href]").length) {
          nextP = nextP.next();
        }
        if (!nextP.length || nextP.is("hr")) return;

        let btn: any;
        if (type === "series") {
          btn = nextP
            .find(
              "a:contains('Episode Links'), a:contains('V-Cloud'), a:contains('vcloud'), a:contains('M-Cloud'), a[href*='vcloud']",
            )
            .first();
          if (!btn.length) {
            btn = nextP
              .find("a[href]")
              .filter((__: number, a: any) => {
                const txt = $(a).text().toLowerCase();
                const href = ($(a).attr("href") || "").toLowerCase();
                return (
                  !txt.includes("zip") &&
                  !txt.includes("batch") &&
                  !href.includes("zip") &&
                  !href.includes("batch")
                );
              })
              .first();
          }
          // If Batch/Zip is the ONLY link in this block, still include it so playback never reports empty linkList
          if (!btn.length) {
            btn = nextP.find("a[href]").first();
          }
        } else {
          btn = nextP
            .find(
              "a:contains('V-Cloud'), a:contains('vcloud'), a:contains('M-Cloud'), a[href*='vcloud']",
            )
            .first();
          if (!btn.length) {
            btn = nextP
              .find(
                "a:contains('G-Direct'), a:contains('Direct'), a[href*='fastdl']",
              )
              .first();
          }
          if (!btn.length) {
            btn = nextP.find(".dwd-button, .btn-outline").first().parent();
          }
          if (!btn.length || !btn.attr("href")) {
            btn = nextP.find("a[href]").first();
          }
        }

        if (!btn || !btn.length) return;
        const btnHref = normalizeRogLockerUrl(btn.attr("href") || "");
        if (!btnHref || btnHref === "/" || btnHref === "#") return;

        if (
          links.some(
            (l) =>
              l.episodesLink === btnHref ||
              (l.directLinks && l.directLinks[0]?.link === btnHref),
          )
        ) {
          return;
        }

        if (type === "series") {
          links.push({
            title: itemTitle,
            episodesLink: btnHref,
            quality,
          });
        } else {
          const directLinks: { title: string; link: string; type: "movie" }[] = [];
          nextP.find("a[href]").each((_: number, a: any) => {
            const h = normalizeRogLockerUrl($(a).attr("href") || "");
            const t = $(a).text().trim() || "Movie";
            if (h && h !== "/" && h !== "#" && !directLinks.some((d) => d.link === h)) {
              directLinks.push({ title: t, link: h, type: "movie" });
            }
          });
          if (directLinks.length === 0) {
            directLinks.push({ title: "Movie", link: btnHref, type: "movie" });
          }
          links.push({
            title: itemTitle,
            directLinks,
            quality,
          });
        }
      });
    }

    // 3. Last-resort locker anchor scan so metadata never returns 0 playback links when download buttons exist
    if (links.length === 0) {
      $(
        "a[href*='nexdrive'], a[href*='genxfm'], a[href*='mobilejsr'], a[href*='vcloud'], a[href*='hubcloud'], a[href*='gdflix'], a[href*='fastdl'], a[href*='vegadrive']",
      ).each((idx: number, a: any) => {
        const rawHref = $(a).attr("href") || "";
        const href = normalizeRogLockerUrl(rawHref);
        if (!href || href === "/" || href === "#") return;
        if (href.includes("/download-") || href.includes("rogmovies.digital") || href.includes("roamovies.cyou")) return;
        const prevText =
          $(a).closest("p, div").prev().text().replace(/\s+/g, " ").trim() ||
          $(a).text().replace(/\s+/g, " ").trim() ||
          `Server ${idx + 1}`;
        const quality = prevText.match(/\d+p\b/i)?.[0] || "";
        if (
          links.some(
            (l) =>
              l.episodesLink === href ||
              (l.directLinks && l.directLinks[0]?.link === href),
          )
        ) {
          return;
        }
        if (type === "series") {
          links.push({ title: prevText, episodesLink: href, quality });
        } else {
          links.push({
            title: prevText,
            directLinks: [{ title: "Movie", link: href, type: "movie" }],
            quality,
          });
        }
      });
    }

    const quickDownload =
      await providerContext.kvStore?.get<boolean>("luxMovies_quickDownload");

    const websiteInfo: Info = {
      title,
      synopsis,
      image,
      imdbId: imdbId || "",
      type,
      quickDownload: quickDownload ?? true,
      linkList: formatSeasonLinks(links),
      webUrl: url,
    };

    if (!imdbId) return websiteInfo;

    try {
      const cinemeta = await getCinemetaMeta(imdbId, type, providerContext);
      if (cinemeta) {
        if (type === "series" && cinemeta.type === "series") {
          websiteInfo.linkList = websiteInfo.linkList.map((item) => {
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
        return applyCinemetaMeta(websiteInfo, cinemeta);
      }
    } catch (e) {
      console.warn("LuxMovies: Cinemeta lookup failed", e);
    }

    return websiteInfo;
  } catch (error) {
    console.log("getInfo error");
    console.error(error);
    throw error;
  }
};
