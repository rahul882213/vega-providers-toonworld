import { formatSeasonLinks } from "../formatSeasonLinks";
import { Info, Link, ProviderContext } from "../types";
import {
  addCinemetaContext,
  applyCinemetaMeta,
  getCinemetaMeta,
  getCinemetaSeason,
} from "../getCinemetaMeta";
import { fetchRogWithWAF, getRogMoviesBaseUrl } from "./posts";

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
    console.log("url", url);
    const response = await fetchRogWithWAF(url, providerContext);
    const $ = cheerio.load(response.data);
    const infoContainer = $(
      ".entry-content, .post-inner, .post-content, .page-body",
    );

    // title
    let title = $("h1.post-title, h1.entry-title, .mfx-main-title")
      .first()
      .text()
      .replace(/^Download\s+/i, "")
      .trim();
    if (!title) {
      const heading = infoContainer?.find("h3");
      const titleRegex = /Name: (.+)/;
      title = heading?.next("p")?.text()?.match(titleRegex)?.[1] || "";
    }

    // imdbId
    let imdbId =
      $('a[href*="imdb.com"]').attr("href")?.match(/tt\d+/)?.[0] || "";
    if (!imdbId) {
      const heading = infoContainer?.find("h3");
      imdbId =
        heading?.next("p")?.find("a")?.attr("href")?.match(/tt\d+/g)?.[0] ||
        infoContainer.text().match(/tt\d+/g)?.[0] ||
        "";
    }

    // type
    let type = "movie";
    const heading = infoContainer?.find("h3");
    const pageText = `${title} ${infoContainer.text()}`;
    if (
      heading?.next("p")?.text()?.includes("Series Name") ||
      /\b(?:web\s+series|season\s*\d{1,2}|s\d{1,2}\s*e\d{1,3})\b/i.test(
        pageText,
      )
    ) {
      type = "series";
    }

    // synopsis
    let synopsis = "";
    const synopsisHeader = $("h3, h2").filter(
      (i, el) =>
        $(el).text().includes("SYNOPSIS/PLOT") || $(el).text().includes("Plot"),
    );
    if (synopsisHeader.length > 0) {
      synopsis = synopsisHeader.next("p, div").text().trim();
    }
    if (!synopsis) {
      synopsis = $(".mfx-plot-box").first().text().trim();
    }
    if (!synopsis) {
      const synopsisNode = //@ts-ignore
        infoContainer?.find("p")?.next("h3,h4")?.next("p")?.[0]?.children?.[0];
      synopsis =
        synopsisNode && "data" in synopsisNode ? synopsisNode.data : "";
    }

    // image
    let image =
      infoContainer?.find("img[data-lazy-src]")?.attr("data-lazy-src") ||
      infoContainer
        ?.find("img")
        ?.filter((i, el) => {
          const src = $(el).attr("src");
          return (
            !!src &&
            !src.includes("logo") &&
            !src.includes("svg") &&
            !src.includes("placeholder") &&
            !src.includes("icon")
          );
        })
        ?.first()
        ?.attr("src") ||
      $("meta[property='og:image']").attr("content") ||
      "";
    if (image.startsWith("//")) {
      image = "https:" + image;
    }

    console.log({ title, synopsis, image, imdbId, type });

    /// Links
    let hr = infoContainer?.first()?.find("hr");
    const firstButton = $(
      ".dwd-button, a[href*='nexdrive'], a[href*='vcloud'], a[href*='fastdl'], a[href*='hubcloud'], a[href*='mobilejsr']",
    ).first();
    if (firstButton.length > 0) {
      const containerP = firstButton.closest("p");
      let prev = containerP.prev();
      while (prev.length && !prev.is("hr")) {
        prev = prev.prev();
      }
      if (prev.is("hr")) {
        hr = prev;
      }
    }

    const list = hr?.length
      ? hr.nextUntil("hr")
      : infoContainer?.find("h1, h2, h3, h4, h5, h6, p");
    const links: Link[] = [];

    list.each((index, element: any) => {
      element = $(element) as any;
      if (element.find("a[href]").length > 0) return;
      if (
        !element.is("h1, h2, h3, h4, h5, h6") &&
        !(element.is("p") && element.find("strong").length > 0)
      ) {
        return;
      }

      let itemTitle = element.text().replace(/\s+/g, " ").trim();
      const lower = itemTitle.toLowerCase();
      if (
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
        const nextEl = element.next();
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

      let nextP = element.next();
      while (nextP.length && !nextP.is("hr") && !nextP.find("a[href]").length) {
        nextP = nextP.next();
      }
      if (!nextP.length || nextP.is("hr")) return;

      let btn;
      if (type === "series") {
        btn = nextP
          .find(
            "a:contains('V-Cloud'), a:contains('vcloud'), a:contains('M-Cloud'), a[href*='vcloud']",
          )
          .first();
        if (!btn.length) {
          btn = nextP
            .find("a")
            .filter((_: number, a: any) => {
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
      const btnHref = btn.attr("href") || "";
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
        links.push({
          title: itemTitle,
          directLinks: [{ title: "Movie", link: btnHref, type: "movie" }],
          quality,
        });
      }
    });

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
            const season = getCinemetaSeason(item.title);
            if (!season) return item;
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
