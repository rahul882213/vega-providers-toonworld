import { Stream, ProviderContext } from "../types";
import { hubcloudExtractor } from "../extractors/hubcloud";
import { gdflixExtractor } from "../extractors/gdflix";
import { vegadriveExtractor } from "../extractors/vegadrive";
import { extractCinejoyStreams } from "../extractors/cinejoy";
import { extractMovyStreams } from "../extractors/movy";
import { extractVidstuckStreams } from "../extractors/vidstuck";
import { getCinemetaMeta } from "../getCinemetaMeta";
import { throwProviderError } from "../providerErrors";
import { getWithWAF, normalizeCinewoodLink } from "./helper";

interface ParsedStreamMeta {
  imdbId?: string;
  season?: number;
  episode?: number;
  title?: string;
  type?: string;
}

function parseStreamMeta(rawLink: string): {
  cleanLink: string;
  meta: ParsedStreamMeta;
} {
  try {
    const parsed = new URL(rawLink);
    const params = new URLSearchParams(parsed.hash.replace(/^#/, ""));
    const encoded = params.get("cinemetaMeta");
    parsed.hash = "";
    if (encoded) {
      const meta = JSON.parse(decodeURIComponent(encoded)) as ParsedStreamMeta;
      return { cleanLink: parsed.href, meta: meta || {} };
    }
    return { cleanLink: parsed.href, meta: {} };
  } catch {
    return { cleanLink: rawLink.split("#")[0], meta: {} };
  }
}

async function resolveFallbackMultiStreams({
  meta,
  type,
  providerContext,
  signal,
}: {
  meta: ParsedStreamMeta;
  type: string;
  providerContext: ProviderContext;
  signal: AbortSignal;
}): Promise<Stream[]> {
  if (!meta.imdbId) return [];
  try {
    const effectiveType = meta.type || type || "movie";
    const cinemeta = await getCinemetaMeta(
      meta.imdbId,
      effectiveType,
      providerContext,
    );
    const tmdbId = cinemeta?.moviedb_id ? String(cinemeta.moviedb_id) : "";
    const title = meta.title || cinemeta?.name || "";
    const year = cinemeta?.year ? String(cinemeta.year).slice(0, 4) : "";
    const season = Number(meta.season || 1);
    const episode = Number(meta.episode || 1);
    if (!tmdbId) return [];

    const [cj, mv, vs] = await Promise.all([
      extractCinejoyStreams({
        tmdbId,
        season,
        episode,
        type: effectiveType,
        providerContext,
        signal,
      }).catch(() => [] as Stream[]),
      extractMovyStreams({
        tmdbId,
        imdbId: meta.imdbId,
        title,
        year,
        season,
        episode,
        type: effectiveType,
        providerContext,
        signal,
      }).catch(() => [] as Stream[]),
      extractVidstuckStreams({
        tmdbId,
        imdbId: meta.imdbId,
        title,
        year,
        season,
        episode,
        type: effectiveType,
        providerContext,
        signal,
      }).catch(() => [] as Stream[]),
    ]);

    return [...(cj || []), ...(vs || []), ...(mv || [])];
  } catch {
    return [];
  }
}

export async function getStream({
  link,
  type,
  signal,
  providerContext,
  isDownload,
}: {
  link: string;
  type: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
  isDownload?: boolean;
}) {
  const { axios, cheerio, commonHeaders, openWebView } = providerContext;
  const { cleanLink, meta } = parseStreamMeta(link);
  let processLink = normalizeCinewoodLink(cleanLink);
  const streamLinks: Stream[] = [];

  const addStream = (s: Stream) => {
    if (s.link && !streamLinks.some((ex) => ex.link === s.link)) {
      streamLinks.push(s);
    }
  };

  try {
    if (processLink.includes("oxxfile")) {
      try {
        const urlObj = new URL(processLink);
        const id = processLink.split("/").filter(Boolean).pop();
        const apiUrl = `${urlObj.origin}/api/s/${id}/hubcloud`;
        try {
          const apiRes = await axios.get(apiUrl, {
            headers: commonHeaders,
            maxRedirects: 5,
            signal,
          });
          const finalUrl =
            apiRes.request?.res?.responseUrl || apiRes.config?.url;
          if (finalUrl && finalUrl.includes("hubcloud")) {
            processLink = finalUrl;
          } else if (
            apiRes.data &&
            typeof apiRes.data === "object" &&
            apiRes.data.link
          ) {
            processLink = apiRes.data.link;
          }
        } catch {
          const res = await fetch(apiUrl, {
            headers: commonHeaders,
            redirect: "follow",
            signal,
          });
          if (res.url && res.url.includes("hubcloud")) {
            processLink = res.url;
          }
        }
      } catch (e) {
        console.log("Error resolving oxxfile link", e);
      }
    } else if (
      !/hubcloud|vcloud|gdflix/i.test(processLink) &&
      /mobilejsr|genxfm|nexdrive|dotlink/i.test(processLink)
    ) {
      try {
        const dotlinkRes = await getWithWAF(
          processLink,
          axios,
          openWebView,
          commonHeaders,
        );
        const dotlinkText =
          typeof dotlinkRes?.data === "string" ? dotlinkRes.data : "";
        if (dotlinkText) {
          const $ = cheerio.load(dotlinkText);

          // 1. G-Direct / Instant / Zee-DL / FastDL
          const gDirectLink = $(
            "a:contains('G-Direct'), a:contains('Instant'), a[href*='zee-dl'], a[href*='fastdl']",
          )
            .first()
            .attr("href");
          if (gDirectLink) {
            try {
              const fastdlRes = await axios.get(gDirectLink, {
                headers: {
                  "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                  ...commonHeaders,
                  Referer: processLink,
                },
                signal,
                timeout: 10000,
              });
              const m = String(fastdlRes.data || "").match(
                /reurl\s*=\s*["']([^"']+)["']/,
              );
              if (m?.[1]) {
                const targetUrl = m[1].includes("link=")
                  ? decodeURIComponent(m[1].split("link=")[1])
                  : m[1];
                if (targetUrl.startsWith("http")) {
                  addStream({
                    server: "Instant (Google CDN)",
                    link: targetUrl,
                    type: "mkv",
                  });
                }
              }
            } catch (e: any) {
              console.log("1CineVood FastDL error:", e?.message);
            }
          }

          // 2. V-Drive / VegaDrive
          const vdHref = $(
            "a:contains('V-Drive'), a:contains('Vega Drive'), a[href*='vegadrive']",
          )
            .first()
            .attr("href");
          if (vdHref) {
            try {
              const vdStreams = await vegadriveExtractor(
                vdHref,
                axios,
                providerContext,
              );
              if (Array.isArray(vdStreams)) {
                for (const s of vdStreams) addStream(s);
              }
            } catch (e: any) {
              console.log("1CineVood VegaDrive error:", e?.message);
            }
          }

          // 3. V-Cloud / Zee-Cloud / M-Cloud / HubCloud / GDFlix
          const vcloudHref =
            $(
              "a:contains('V-Cloud'), a:contains('Zee-Cloud'), a:contains('M-Cloud'), a[href*='vcloud'], a[href*='zcloud'], a[href*='hubcloud']",
            )
              .first()
              .attr("href") ||
            dotlinkText.match(/<a\s+href="([^"]*cloud\.[^"]*)"/i)?.[1];

          if (vcloudHref) {
            processLink = vcloudHref;
          } else {
            const gdHref = $("a[href*='gdflix']").first().attr("href");
            if (gdHref) {
              processLink = gdHref;
            }
          }
        }
      } catch (e) {
        console.log("Error resolving intermediate Cinewood locker link", e);
      }
    }

    if (processLink.includes("vegadrive")) {
      try {
        const vdStreams = await vegadriveExtractor(
          processLink,
          axios,
          providerContext,
        );
        if (Array.isArray(vdStreams)) {
          for (const s of vdStreams) addStream(s);
        }
      } catch (e: any) {
        console.log("1CineVood direct VegaDrive error:", e?.message);
      }
      if (streamLinks.length > 0) return streamLinks;
    }

    if (processLink.includes("zee-dl") || processLink.includes("fastdl")) {
      try {
        const fastdlRes = await axios.get(processLink, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            ...commonHeaders,
            Referer: "https://nexdrive.store/",
          },
          signal,
          timeout: 10000,
        });
        const m = String(fastdlRes.data || "").match(
          /reurl\s*=\s*["']([^"']+)["']/,
        );
        if (m?.[1]) {
          const targetUrl = m[1].includes("link=")
            ? decodeURIComponent(m[1].split("link=")[1])
            : m[1];
          if (targetUrl.startsWith("http")) {
            addStream({
              server: "Instant (Google CDN)",
              link: targetUrl,
              type: "mkv",
            });
          }
        }
      } catch {}
      if (streamLinks.length > 0) return streamLinks;
    }

    if (processLink.includes("gdflix")) {
      const gdStreams = await gdflixExtractor(
        processLink,
        signal,
        axios,
        cheerio,
        commonHeaders,
        streamLinks.length > 0
          ? { ...providerContext, openWebView: undefined as any }
          : providerContext,
      );
      if (Array.isArray(gdStreams) && gdStreams.length > 0) {
        for (const s of gdStreams) addStream(s);
      }
      if (streamLinks.length > 0) return streamLinks;
    }

    if (
      /hubcloud|vcloud|zcloud|oxxfile/i.test(processLink) &&
      !/mobilejsr|genxfm|nexdrive/i.test(processLink)
    ) {
      try {
        const hubcloudLink = await hubcloudExtractor(
          processLink,
          signal,
          axios,
          cheerio,
          commonHeaders,
          streamLinks.length > 0
            ? { ...providerContext, openWebView: undefined as any }
            : providerContext,
          isDownload,
          "1cinevood",
        );
        if (Array.isArray(hubcloudLink) && hubcloudLink.length > 0) {
          for (const s of hubcloudLink) addStream(s);
        }
      } catch (hcErr) {
        if (streamLinks.length === 0) {
          console.warn("1CineVood HubCloud error:", hcErr);
        }
      }
    }

    if (streamLinks.length > 0) {
      return streamLinks;
    }

    const fallbackStreams = await resolveFallbackMultiStreams({
      meta,
      type,
      providerContext,
      signal,
    });
    if (fallbackStreams.length > 0) {
      return fallbackStreams;
    }

    return streamLinks;
  } catch (error: any) {
    if (streamLinks.length > 0) {
      return streamLinks;
    }
    const fallbackStreams = await resolveFallbackMultiStreams({
      meta,
      type,
      providerContext,
      signal,
    });
    if (fallbackStreams.length > 0) {
      return fallbackStreams;
    }
    throwProviderError("1CineVood", "stream", error);
  }
}
