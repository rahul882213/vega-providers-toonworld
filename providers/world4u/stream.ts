import { ProviderContext, Stream } from "../types";
import { throwProviderError } from "../providerErrors";
import { extractCinejoyStreams } from "../extractors/cinejoy";
import { extractMovyStreams } from "../extractors/movy";
import { extractVidstuckStreams } from "../extractors/vidstuck";
import { hubcloudExtractor } from "../extractors/hubcloud";
import { gdflixExtractor } from "../extractors/gdflix";
import { lookupTmdbByTitleAndPoster, readW4uMeta, W4uStreamMeta } from "./meta";
import { getWorld4uBaseUrl } from "./posts";

const defaultHeaders: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

async function resolveZetaflixStreams({
  pageUrl,
  meta,
  type,
  signal,
  providerContext,
}: {
  pageUrl: string;
  meta: W4uStreamMeta;
  type: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Stream[]> {
  const { axios, cheerio, commonHeaders } = providerContext;
  const baseUrl = await getWorld4uBaseUrl();
  const streams: Stream[] = [];

  let html = "";
  try {
    const res = await axios.get(pageUrl, {
      signal,
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: `${baseUrl}/`,
      },
      timeout: 10000,
    });
    html = typeof res.data === "string" ? res.data : "";
  } catch {}

  const $ = html ? cheerio.load(html) : null;

  let title = meta.title || "";
  let year = meta.year || "";
  let posterFile = meta.posterFile || "";
  let season = Number(meta.season || 1);
  let episode = Number(meta.episode || 1);
  const effectiveType: "movie" | "series" =
    meta.type === "series" ||
    type === "series" ||
    /\/episodes\/|\/tvshows\//i.test(pageUrl)
      ? "series"
      : "movie";

  const epSlugMatch = pageUrl.match(/[-/](\d+)x(\d+)\/?$/i);
  if (epSlugMatch) {
    season = Number(epSlugMatch[1]) || season;
    episode = Number(epSlugMatch[2]) || episode;
  }

  if ($) {
    if (!title) {
      const serieText = $(".details-info, .info-col")
        .text()
        .match(/Serie:\s*([^\n\r]+)/i)?.[1];
      title = (
        serieText ||
        $(".details-title h3, .details-title h1, h1")
          .first()
          .text()
          .replace(/:\s*\d+\s*[x×]\s*\d+.*$/i, "")
      ).trim();
    }
    if (!year) {
      year =
        $(".details-info, .info-col")
          .text()
          .match(/Year:\s*(\d{4})/i)?.[1] || "";
    }
    if (!posterFile) {
      const posterSrc =
        $(".content-poster img").attr("src") ||
        $("meta[property='og:image']").attr("content") ||
        "";
      posterFile = posterSrc.split("/").pop()?.split("?")[0] || "";
    }

    // 1. Check Zetaflix player options (excluding "fake")
    const playerOptions = $(
      "#playeroptionsul li.zetaflix_player_option, .zetaflix_player_option",
    ).toArray();

    let trailerEmbedUrl = "";
    for (const optEl of playerOptions) {
      const opt = $(optEl);
      const post = opt.attr("data-post") || meta.postId || "";
      const pType =
        opt.attr("data-type") || (effectiveType === "series" ? "ep" : "mv");
      const nume = opt.attr("data-nume") || "";
      const serverLabel =
        opt.find(".title, .server").text().trim() ||
        opt.text().replace(/\s+/g, " ").trim() ||
        `Server ${nume}`;

      if (!post || !nume || nume === "fake") continue;

      try {
        const body = new URLSearchParams({
          action: "zeta_player_ajax",
          post,
          nume,
          type: pType,
        });
        const ajaxRes = await axios.post(
          `${baseUrl}/wp-admin/admin-ajax.php`,
          body.toString(),
          {
            signal,
            headers: {
              ...defaultHeaders,
              ...commonHeaders,
              "Content-Type": "application/x-www-form-urlencoded",
              Referer: pageUrl,
            },
            timeout: 8000,
          },
        );
        const embedData = ajaxRes.data;
        let embedUrl =
          typeof embedData === "object" ? embedData?.embed_url || "" : "";
        if (embedUrl && embedUrl.includes("<iframe")) {
          const $iframe = cheerio.load(embedUrl);
          embedUrl = $iframe("iframe").attr("src") || "";
        }
        if (!embedUrl || !embedUrl.startsWith("http")) continue;

        if (nume === "trailer" || /youtube\.com|youtu\.be/i.test(embedUrl)) {
          trailerEmbedUrl = embedUrl;
          continue;
        }

        const ext = embedUrl.includes(".m3u8")
          ? "m3u8"
          : embedUrl.includes(".mp4")
            ? "mp4"
            : embedUrl.includes(".mkv")
              ? "mkv"
              : "m3u8";
        streams.push({
          server: serverLabel,
          link: embedUrl,
          type: ext,
          quality: "1080",
          headers: {
            Referer: pageUrl,
          },
        });
      } catch {}
    }

    // 2. Check #links / download table if present
    const dlLinks = $(
      "#links a[href], .links_table a[href], .download-links a[href]",
    ).toArray();
    for (const aEl of dlLinks) {
      const href = $(aEl).attr("href") || "";
      if (!href || !href.startsWith("http")) continue;
      if (/hubcloud|vcloud/i.test(href)) {
        try {
          const hc = await hubcloudExtractor(
            href,
            signal,
            axios,
            cheerio,
            commonHeaders,
            providerContext,
            false,
            "world4u",
          );
          if (Array.isArray(hc)) streams.push(...hc);
        } catch {}
      } else if (/gdflix/i.test(href)) {
        try {
          const gd = await gdflixExtractor(
            href,
            signal,
            axios,
            cheerio,
            commonHeaders,
            providerContext,
          );
          if (Array.isArray(gd)) streams.push(...gd);
        } catch {}
      }
    }

    // 3. Resolve TMDB / IMDb and run multi-stream extractors (Cinejoy, Vidstuck, Movy)
    let tmdbId = meta.tmdbId || "";
    let imdbId = meta.imdbId || "";
    if (!tmdbId && title) {
      const resolved = await lookupTmdbByTitleAndPoster({
        title,
        year,
        posterFile,
        type: effectiveType,
        axios,
        commonHeaders,
      });
      tmdbId = resolved.tmdbId;
      if (!imdbId) imdbId = resolved.imdbId;
      if (!year) year = resolved.year;
    }

    if (tmdbId) {
      const [cjStreams, vsStreams, mvStreams] = await Promise.all([
        extractCinejoyStreams({
          tmdbId,
          season,
          episode,
          type: effectiveType,
          providerContext,
          signal,
        }).catch(() => [] as Stream[]),
        extractVidstuckStreams({
          tmdbId,
          imdbId,
          title,
          year,
          season,
          episode,
          type: effectiveType,
          providerContext,
          signal,
        }).catch(() => [] as Stream[]),
        extractMovyStreams({
          tmdbId,
          imdbId,
          title,
          year,
          season,
          episode,
          type: effectiveType,
          providerContext,
          signal,
        }).catch(() => [] as Stream[]),
      ]);

      for (const s of [
        ...(cjStreams || []),
        ...(vsStreams || []),
        ...(mvStreams || []),
      ]) {
        if (
          s?.link &&
          !s.server.toLowerCase().includes("lisbon") &&
          !s.link.includes("cheaptruckrepairs") &&
          !streams.some((existing) => existing.link === s.link)
        ) {
          streams.push(s);
        }
      }
    }

    // If no direct streams were found from external CDNs and Zetaflix had a trailer/embed, include it as fallback
    if (streams.length === 0 && trailerEmbedUrl) {
      streams.push({
        server: "World4uFree Official Trailer",
        link: trailerEmbedUrl,
        type: "m3u8",
        quality: "720",
      });
    }
  }

  return streams;
}

export const getStream = async function ({
  link: rawUrl,
  type,
  signal,
  providerContext,
}: {
  link: string;
  type: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Stream[]> {
  const { axios, cheerio, commonHeaders: headers } = providerContext;
  try {
    const { requestUrl, meta } = readW4uMeta(rawUrl);
    let url = requestUrl;

    // 1. Handle modern World4uFree (world4ufree.co.in Zetaflix) URLs
    if (
      /world4ufree\.co\.in/i.test(url) ||
      /\/(?:movies|tvshows|episodes)\//i.test(url) ||
      meta.postId ||
      meta.tmdbId
    ) {
      const zetaStreams = await resolveZetaflixStreams({
        pageUrl: url,
        meta,
        type,
        signal,
        providerContext,
      });
      if (zetaStreams.length > 0) {
        return zetaStreams;
      }
    }

    // 2. Legacy World4u (wlink / fastilinks / photolinx / mediafire) flow
    if (type === "movie") {
      const linkRes = await axios.get(url, { headers });
      const linkData = linkRes.data;
      const $ = cheerio.load(linkData);
      url = $('strong:contains("INSTANT")').parent().attr("href") || url;
    }

    // fastilinks
    if (url.includes("fastilinks")) {
      const fastilinksRes = await axios.get(url, { headers });
      const fastilinksData = fastilinksRes.data;
      const $$ = cheerio.load(fastilinksData);
      const fastilinksKey = $$(
        'input[name="_csrf_token_645a83a41868941e4692aa31e7235f2"]',
      ).attr("value");
      const fastilinksFormData = new FormData();
      fastilinksFormData.append(
        "_csrf_token_645a83a41868941e4692aa31e7235f2",
        fastilinksKey || "",
      );
      const fastilinksRes2 = await fetch(url, {
        method: "POST",
        headers: headers,
        body: fastilinksFormData,
      });
      if (!fastilinksRes2.ok) {
        throw new Error(
          `HTTP ${fastilinksRes2.status} ${fastilinksRes2.statusText} | URL ${url}`,
        );
      }
      const fastilinksHtml = await fastilinksRes2.text();
      const $$$ = cheerio.load(fastilinksHtml);
      const fastilinksLink =
        $$$('a:contains("mediafire")').attr("href") ||
        $$$('a:contains("photolinx")').attr("href");
      url = fastilinksLink || url;
    }

    if (url.includes("photolinx")) {
      const photolinxBaseUrl = url.split("/").slice(0, 3).join("/");
      const photolinxRes = await fetch(
        "https://photolinx.space/download/SzbPKzt6YMO",
        {
          headers: {
            accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "accept-language": "en-US,en;q=0.9,en-IN;q=0.8",
            "cache-control": "no-cache",
            pragma: "no-cache",
            priority: "u=0, i",
            "sec-ch-ua":
              '"Not;A=Brand";v="99", "Microsoft Edge";v="139", "Chromium";v="139"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "none",
            "sec-fetch-user": "?1",
            "upgrade-insecure-requests": "1",
            cookie:
              "PHPSESSID=f2211def7938d7228daaa37ffeabcfe0; ext_name=ojplmecpdpgccookcobabopnaifgidhf",
          },
          body: null,
          method: "GET",
        },
      );
      const photolinxData = await photolinxRes.text();
      const $$$ = cheerio.load(photolinxData);
      const access_token = $$$("#generate_url").attr("data-token");
      const uid = $$$("#generate_url").attr("data-uid");
      const body = {
        type: "DOWNLOAD_GENERATE",
        payload: {
          access_token,
          uid,
        },
      };

      const photolinxRes2 = await fetch(`${photolinxBaseUrl}/action`, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9,en-IN;q=0.8",
          "cache-control": "no-cache",
          "content-type": "application/json; charset=UTF-8",
          pragma: "no-cache",
          priority: "u=1, i",
          "sec-ch-ua":
            '"Not;A=Brand";v="99", "Microsoft Edge";v="139", "Chromium";v="139"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
          "x-requested-with": "xmlhttprequest",
          cookie:
            "PHPSESSID=f2211def7938d7228daaa37ffeabcfe0; ext_name=ojplmecpdpgccookcobabopnaifgidhf",
          Referer: url,
        },
        body: JSON.stringify(body),
        method: "POST",
      });
      const photolinxData2 = await photolinxRes2.json();
      const dwUrl = photolinxData2?.download_url;
      if (dwUrl) {
        return [
          {
            server: "Photolinx",
            link: dwUrl,
            type: "mkv",
          },
        ];
      }
    }

    const res = await fetch(url, { headers: headers });
    const html = await res.text();
    const streamLinks: Stream[] = [];
    let data = { download: "" };
    try {
      const key =
        html.match(/formData\.append\('key',\s*'(\d+)'\);/)?.[1] || "";
      if (key) {
        const formData = new FormData();
        formData.append("key", key);
        const streamRes = await fetch(url, {
          method: "POST",
          headers: headers,
          body: formData,
        });
        data = await streamRes.json();
      }
    } catch (err) {
      console.log(
        "error in world4uGetStream",
        err instanceof Error ? err.message : err,
      );
    }

    const $ = cheerio.load(html);
    const mediafireUrl =
      $('h1:contains("Download")').find("a").attr("href") ||
      $(".input.popsok").attr("href") ||
      "";
    if (mediafireUrl) {
      const directUrl = await fetch(mediafireUrl, {
        headers: {
          Referer: url,
        },
      });
      const urlContentType = directUrl.headers.get("content-type");
      if (urlContentType && urlContentType.includes("video")) {
        streamLinks.push({
          server: "Mediafire",
          link: mediafireUrl,
          type: "mkv",
        });
        return streamLinks;
      } else {
        const repairRes = await fetch(mediafireUrl, {
          headers: {
            Referer: url,
          },
        });
        const repairHtml = await repairRes.text();
        const base64Link = cheerio
          .load(repairHtml)(".input.popsok")
          .attr("data-scrambled-url");
        const href = base64Link ? atob(base64Link) : null;
        const downloadLInk = href?.startsWith("https://") ? href : null;
        if (downloadLInk) {
          streamLinks.push({
            server: "Mediafire",
            link: downloadLInk,
            type: "mkv",
          });
        }
        return streamLinks;
      }
    }

    if (data.download) {
      const requireRepairRes = await fetch(data.download);
      const contentType = requireRepairRes.headers.get("content-type");
      if (contentType && contentType.includes("video")) {
        streamLinks.push({
          server: "Mediafire",
          link: data.download,
          type: "mkv",
        });
        return streamLinks;
      } else {
        const repairRes = await fetch(data.download, {
          headers: {
            Referer: url,
          },
        });
        const repairHtml = await repairRes.text();
        const $r = cheerio.load(repairHtml);
        const repairLink = $r("#continue-btn").attr("href");
        if (repairLink) {
          const repairRequireRepairRes = await fetch(
            "https://www.mediafire.com" + repairLink,
          );
          const $$ = cheerio.load(await repairRequireRepairRes.text());
          const repairDownloadLink = $$(".input.popsok").attr("href");
          if (repairDownloadLink) {
            streamLinks.push({
              server: "Mediafire",
              link: repairDownloadLink,
              type: "mkv",
            });
          }
        }
      }
    }

    return streamLinks;
  } catch (err) {
    throwProviderError("World4u", "stream", err);
  }
};
