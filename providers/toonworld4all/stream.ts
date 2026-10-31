import { ProviderContext, Stream } from "../types";
import { throwProviderError } from "../providerErrors";
import { hubcloudExtractor } from "../extractors/hubcloud";
import { gdflixExtractor } from "../extractors/gdflix";

const BASE_URL = "https://toonworld4all.me";
const ARCHIVE_HOST = "archive.toonworld4all.me";

const normalizeQuality = (
  q?: string,
): "360" | "480" | "720" | "1080" | "2160" | undefined => {
  if (!q) return undefined;
  const match = String(q).match(/(360|480|720|1080|2160)/);
  return match ? (match[1] as any) : undefined;
};

function safeParseProps(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return new Function(`return (${raw});`)();
    } catch {
      return null;
    }
  }
}

function sortStreams(streams: Stream[], isDownload?: boolean): Stream[] {
  const getScore = (s: Stream) => {
    const server = (s.server || "").toLowerCase();
    const type = (s.type || "").toLowerCase();
    const isDirectVideo = type === "mkv" || type === "mp4" || type === "m3u8";

    if (isDownload) {
      if (server.includes("cf storage") || server.includes("storage")) return 1;
      if (server.includes("gdrive") || server.includes("google")) return 2;
      if (server.includes("pixeldrain")) return 3;
      if (server.includes("gofile")) return 4;
      if (server.includes("fastdl")) return 5;
      if (server.includes("hubcdn")) return 6;
      if (!isDirectVideo) return 100;
      return 20;
    } else {
      if (server === "toonworld player") return 1;
      if (type === "m3u8") return 2;
      if (server.includes("cf storage") || server.includes("storage")) return 3;
      if (server.includes("cf worker") || server.includes("fast cloud")) return 4;
      if (server.includes("pixeldrain")) return 5;
      if (server.includes("gofile")) return 6;
      if (server.includes("fastdl") || server.includes("fsl")) return 7;
      if (server.includes("hubcdn")) return 8;
      if (server.includes("gdrive") || server.includes("google")) return 9;
      if (!isDirectVideo) return 100;
      return 15;
    }
  };

  return streams.sort((a, b) => getScore(a) - getScore(b));
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
  signal?: AbortSignal;
  providerContext: ProviderContext;
  isDownload?: boolean;
}): Promise<Stream[]> {
  void type;
  const streamLinks: Stream[] = [];
  const seen = new Set<string>();

  const addStream = (stream: Stream) => {
    if (!stream || !stream.link || !stream.server || !stream.type) return;
    if (seen.has(stream.link)) return;
    seen.add(stream.link);
    streamLinks.push(stream);
  };

  const { axios, cheerio, commonHeaders = {} } = providerContext || {};
  const abortSignal = signal || new AbortController().signal;

  let targetUrl = link;
  try {
    targetUrl = new URL(link, `https://${ARCHIVE_HOST}`).href;
  } catch {
    targetUrl = link;
  }

  try {
    // If incoming link is already a direct third-party hosting link
    if (link.includes("hubcloud") || link.includes("vcloud")) {
      try {
        const hcStreams = await hubcloudExtractor(
          link,
          abortSignal,
          axios,
          cheerio,
          commonHeaders,
          providerContext,
          isDownload,
          "toonworld4all",
        );
        if (Array.isArray(hcStreams)) {
          for (const s of hcStreams) {
            addStream({
              ...s,
              quality: normalizeQuality(s.quality),
            });
          }
        }
      } catch {
        // Fallback below
      }

      if (streamLinks.length === 0) {
        addStream({
          server: "HubCloud Mirror",
          link: link,
          type: "iframe",
          quality: "720",
          headers: {
            Referer: BASE_URL,
            "User-Agent": commonHeaders["User-Agent"] || "Mozilla/5.0",
          },
        });
      }
      return sortStreams(streamLinks, isDownload);
    }

    if (link.includes("gdflix")) {
      try {
        const gdStreams = await gdflixExtractor(
          link,
          abortSignal,
          axios,
          cheerio,
          commonHeaders,
          providerContext,
        );
        if (Array.isArray(gdStreams)) {
          for (const s of gdStreams) {
            addStream({
              ...s,
              quality: normalizeQuality(s.quality),
            });
          }
        }
      } catch {
        // Fallback below
      }

      if (streamLinks.length === 0) {
        addStream({
          server: "GDFlix Mirror",
          link: link,
          type: "iframe",
          quality: "720",
          headers: {
            Referer: BASE_URL,
            "User-Agent": commonHeaders["User-Agent"] || "Mozilla/5.0",
          },
        });
      }
      return sortStreams(streamLinks, isDownload);
    }

    const resolveAndExtractFile = async (
      redirectUrl: string,
      quality?: "360" | "480" | "720" | "1080" | "2160",
      tag?: string,
      hostName?: string,
    ) => {
      try {
        const redRes = await axios.get(redirectUrl, {
          headers: {
            ...commonHeaders,
            Referer: targetUrl,
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          },
          signal: abortSignal,
          timeout: 12000,
        });

        const redMatch = redRes.data.match(
          /window\.__PROPS__\s*=\s*({[\s\S]*?});/,
        );
        let hostLink = "";
        let domain = "";
        if (redMatch) {
          const redProps = safeParseProps(redMatch[1]);
          domain = redProps?.link?.domain || "";
          const hidden = redProps?.link?.hidden || "";
          if (domain && hidden) {
            hostLink = domain + hidden;
          }
        }

        // Fallback: search HTML for destination URL if props was absent
        if (!hostLink) {
          const urlMatch = redRes.data.match(/(https?:\/\/[^\s"'<>]*(?:hubcloud|vcloud|gdflix|pixeldrain|gofile)[^\s"'<>]*)/i);
          if (urlMatch) {
            hostLink = urlMatch[1];
            domain = hostLink.split("/").slice(0, 3).join("/");
          }
        }

        if (!hostLink) return;

        let extractedCount = 0;

        if (/hubcloud|vcloud/i.test(domain) || /hubcloud|vcloud/i.test(hostLink)) {
          try {
            const hcStreams = await hubcloudExtractor(
              hostLink,
              abortSignal,
              axios,
              cheerio,
              commonHeaders,
              providerContext,
              isDownload,
              "toonworld4all",
            );
            if (Array.isArray(hcStreams) && hcStreams.length > 0) {
              for (const s of hcStreams) {
                addStream({
                  ...s,
                  quality: s.quality || quality,
                  tag: s.tag || tag,
                });
                extractedCount++;
              }
            } else if (hostLink.includes("/drive/")) {
              // Try /video/ path which newer HubCloud mirrors use
              const videoPath = hostLink.replace("/drive/", "/video/");
              const hcStreams2 = await hubcloudExtractor(
                videoPath,
                abortSignal,
                axios,
                cheerio,
                commonHeaders,
                providerContext,
                isDownload,
                "toonworld4all",
              );
              if (Array.isArray(hcStreams2)) {
                for (const s of hcStreams2) {
                  addStream({
                    ...s,
                    quality: s.quality || quality,
                    tag: s.tag || tag,
                  });
                  extractedCount++;
                }
              }
            }
          } catch {
            // Upstream host may be expired or inaccessible
          }
        } else if (/gdflix/i.test(domain) || /gdflix/i.test(hostLink)) {
          try {
            const gdStreams = await gdflixExtractor(
              hostLink,
              abortSignal,
              axios,
              cheerio,
              commonHeaders,
              providerContext,
            );
            if (Array.isArray(gdStreams)) {
              for (const s of gdStreams) {
                addStream({
                  ...s,
                  quality: s.quality || quality,
                  tag: s.tag || tag,
                });
                extractedCount++;
              }
            }
          } catch {
            // GDFlix error or WAF
          }
        } else if (/pixeld/i.test(domain) || /pixeld/i.test(hostLink)) {
          const token = hostLink.split("/").pop()?.split("?")[0];
          const bUrl = hostLink.split("/").slice(0, -2).join("/") || "https://pixeldrain.com";
          const directPixel = `${bUrl}/api/file/${token}?download`;
          addStream({
            server: "Pixeldrain",
            link: directPixel,
            type: "mkv",
            quality: quality || "720",
            tag: tag,
          });
          extractedCount++;
        } else if (/\.(mkv|mp4|m3u8)(\?|$)/i.test(hostLink)) {
          const extMatch = hostLink.match(/\.(mkv|mp4|m3u8)(\?|$)/i);
          const extType = extMatch ? extMatch[1].toLowerCase() : "mkv";
          addStream({
            server: hostName ? `ToonWorld (${hostName})` : "Direct Stream",
            link: hostLink,
            type: extType,
            quality: quality || "720",
            tag: tag,
            headers: {
              Referer: targetUrl,
              "User-Agent": commonHeaders["User-Agent"] || "Mozilla/5.0",
            },
          });
          extractedCount++;
        }

        // If direct extractor did not return streams, add host link as low-priority iframe server (exclude unplayable lockers like mega.nz)
        if (extractedCount === 0 && hostLink.startsWith("http") && !hostLink.includes("mega.nz") && !hostLink.includes("filepress")) {
          addStream({
            server: `ToonWorld Web Mirror (${quality || "HD"} - ${hostName || "Cloud"})`,
            link: hostLink,
            type: "iframe",
            quality: quality || "720",
            tag: tag,
            headers: {
              Referer: targetUrl,
              "User-Agent": commonHeaders["User-Agent"] || "Mozilla/5.0",
            },
          });
        }
      } catch {
        // Network or timeout error resolving redirect
      }
    };

    // Case 1: link is a direct redirect link
    if (targetUrl.includes("/redirect/")) {
      await resolveAndExtractFile(targetUrl, undefined, undefined, "Server");
      if (streamLinks.length === 0) {
        addStream({
          server: "ToonWorld Web Player",
          link: targetUrl,
          type: "iframe",
          quality: "720",
          headers: {
            Referer: BASE_URL,
            "User-Agent": commonHeaders["User-Agent"] || "Mozilla/5.0",
          },
        });
      }
      return sortStreams(streamLinks, isDownload);
    }

    // Case 2: link is an episode or movie page on archive.toonworld4all.me
    let epHtml = "";
    const epHeaders: Record<string, string> = {
      ...commonHeaders,
      Referer: BASE_URL,
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    };

    try {
      const savedCookie = await providerContext?.kvStore?.get<string>("cf_clearance_archive");
      if (savedCookie) {
        epHeaders["Cookie"] = savedCookie;
      }
    } catch {}

    try {
      const epRes = await axios.get(targetUrl, {
        headers: epHeaders,
        signal: abortSignal,
        timeout: 10000,
      });
      epHtml = epRes.data || "";
    } catch (fetchErr: any) {
      const status = fetchErr.response?.status;
      // If 503 (LiteSpeed/Cloudflare server temporary rate limit), retry with delay first
      if (status === 503) {
        try {
          await new Promise((res) => setTimeout(res, 800));
          const retryRes = await axios.get(targetUrl, {
            headers: {
              ...commonHeaders,
              Referer: BASE_URL,
              "User-Agent":
                commonHeaders["User-Agent"] ||
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            },
            signal: abortSignal,
            timeout: 10000,
          });
          epHtml = retryRes.data || "";
        } catch {}
      }

      // If still no epHtml and status is 403 or persistent 503, try openWebView if available
      if (!epHtml && (status === 403 || status === 503) && providerContext?.openWebView) {
        try {
          const wafRes = await providerContext.openWebView(targetUrl, {
            title: "Verifying connection to ToonWorld",
            description: "Please complete the verification to load video streams.",
            headers: epHeaders,
            waitForCookie: "cf_clearance",
            force: true,
          });
          if (wafRes.data) {
            epHtml = wafRes.data;
          }
          if (wafRes.cookies) {
            epHeaders["Cookie"] = (epHeaders["Cookie"] ? epHeaders["Cookie"] + "; " : "") + wafRes.cookies;
            await providerContext?.kvStore?.set("cf_clearance_archive", epHeaders["Cookie"]);
            if (!epHtml) {
              const retryRes = await axios.get(targetUrl, {
                headers: epHeaders,
                signal: abortSignal,
                timeout: 10000,
              });
              epHtml = retryRes.data || "";
            }
          }
        } catch (wafErr) {
          console.warn("openWebView WAF challenge failed:", wafErr);
        }
      } else if (!epHtml) {
        console.warn("Failed to fetch archive page:", fetchErr.message);
      }
    }

    if (epHtml) {
      const propsMatch = epHtml.match(/window\.__PROPS__\s*=\s*({[\s\S]*?});/);
      if (propsMatch) {
        try {
          const props = safeParseProps(propsMatch[1]);
          const data = props?.data?.data;

          // 1. Extract direct streaming players (Cloudflare Pages web player)
          if (Array.isArray(data?.streams)) {
            for (const s of data.streams) {
              const playUrl = s.play || s.link || s.file || s.stream;
              if (playUrl && typeof playUrl === "string") {
                const streamType = playUrl.includes(".m3u8")
                  ? "m3u8"
                  : playUrl.includes(".mp4")
                    ? "mp4"
                    : playUrl.includes(".mkv")
                      ? "mkv"
                      : "iframe";

                addStream({
                  server: "ToonWorld Player",
                  link: playUrl,
                  type: streamType,
                  quality: normalizeQuality(s.quality || s.resolution),
                  headers: {
                    Referer: `https://${ARCHIVE_HOST}/`,
                    "User-Agent": commonHeaders["User-Agent"] || "Mozilla/5.0",
                  },
                });
              }
            }
          }

          // 2. Extract resolution encodes and resolve candidate host links cleanly (without flooding)
          if (Array.isArray(data?.encodes)) {
            // Sort encodes: prefer 720p or 1080p
            const sortedEncodes = [...data.encodes].sort((a, b) => {
              const qA = parseInt(normalizeQuality(a.resolution) || "0", 10);
              const qB = parseInt(normalizeQuality(b.resolution) || "0", 10);
              return qB - qA;
            });

            // Focus on top resolutions to prevent LiteSpeed anti-abuse 503 limits
            for (const enc of sortedEncodes.slice(0, 3)) {
              const cleanQuality = normalizeQuality(enc.resolution);
              const codec = enc.readable?.codec;
              if (Array.isArray(enc.files)) {
                // Prioritize HubCloud and GDFlix which provide direct playable streams
                const sortedFiles = [...enc.files].sort((a, b) => {
                  const aText = ((a.host || "") + (a.short || "")).toLowerCase();
                  const bText = ((b.host || "") + (b.short || "")).toLowerCase();
                  const aScore = /hubcloud|vcloud/i.test(aText) ? 1 : /gdflix/i.test(aText) ? 2 : 10;
                  const bScore = /hubcloud|vcloud/i.test(bText) ? 1 : /gdflix/i.test(bText) ? 2 : 10;
                  return aScore - bScore;
                });

                for (const file of sortedFiles.slice(0, 2)) {
                  const hName = (file.host || file.short || "").toLowerCase();
                  if (hName.includes("mega") || hName.includes("filepress")) continue;

                  if (file.link) {
                    const redirectUrl = new URL(file.link, `https://${ARCHIVE_HOST}`).href;
                    const hostLabel = file.host || file.short || "Cloud";
                    await resolveAndExtractFile(redirectUrl, cleanQuality, codec, hostLabel);

                    const directPlayable = streamLinks.filter(
                      (s) => s.type === "m3u8" || s.type === "mp4" || s.type === "mkv",
                    );
                    if (directPlayable.length >= 2) break;
                  }
                }
              }
              const directPlayable = streamLinks.filter(
                (s) => s.type === "m3u8" || s.type === "mp4" || s.type === "mkv",
              );
              if (directPlayable.length >= 2) break;
            }
          }
        } catch {
          // Ignore JSON parse errors
        }
      }

      // 3. Cheerio DOM fallback extraction for direct video sources, iframes, and redirect links
      if (streamLinks.length === 0) {
        try {
          const $ep = cheerio.load(epHtml);

          // Check video/source elements
          $ep("video, source").each((_i: number, el: any) => {
            const src = $ep(el).attr("src");
            if (src && typeof src === "string" && src.startsWith("http")) {
              const extType = src.includes(".m3u8")
                ? "m3u8"
                : src.includes(".mp4")
                  ? "mp4"
                  : src.includes(".mkv")
                    ? "mkv"
                    : "mp4";
              addStream({
                server: "Direct Player",
                link: src,
                type: extType,
                quality: "720",
                headers: { Referer: targetUrl },
              });
            }
          });

          // Check iframe players
          $ep("iframe[src]").each((_i: number, el: any) => {
            const iSrc = $ep(el).attr("src");
            if (iSrc && (iSrc.includes(".m3u8") || iSrc.includes(".mp4"))) {
              addStream({
                server: "Web Player",
                link: iSrc,
                type: iSrc.includes(".m3u8") ? "m3u8" : "mp4",
                quality: "720",
                headers: { Referer: targetUrl },
              });
            }
          });

          // Check DOM anchor tags for cloud hosting and redirect links
          const domTasks: Promise<any>[] = [];
          $ep("a[href]").each((_i: number, el: any) => {
            const h = $ep(el).attr("href");
            if (!h) return;
            try {
              const p = new URL(h, targetUrl).href;
              if (p.includes("/redirect/")) {
                domTasks.push(resolveAndExtractFile(p, undefined, undefined, "Server"));
              } else if (/hubcloud|vcloud/i.test(p)) {
                domTasks.push(
                  hubcloudExtractor(
                    p,
                    abortSignal,
                    axios,
                    cheerio,
                    epHeaders,
                    providerContext,
                    isDownload,
                    "toonworld4all",
                  ).then((res) => {
                    if (Array.isArray(res)) {
                      for (const s of res) addStream(s);
                    }
                  }).catch(() => {}),
                );
              } else if (/gdflix/i.test(p)) {
                domTasks.push(
                  gdflixExtractor(
                    p,
                    abortSignal,
                    axios,
                    cheerio,
                    epHeaders,
                    providerContext,
                  ).then((res) => {
                    if (Array.isArray(res)) {
                      for (const s of res) addStream(s);
                    }
                  }).catch(() => {}),
                );
              }
            } catch {}
          });

          if (domTasks.length > 0) {
            let timer: any;
            const timeoutPromise = new Promise((res) => {
              timer = setTimeout(res, 12000);
            });
            await Promise.race([Promise.allSettled(domTasks), timeoutPromise]);
            if (timer) clearTimeout(timer);
          }
        } catch {}
      }
    }

    // Fallback: if no direct streams or extractors succeeded, guarantee fallback URL
    if (streamLinks.length === 0 && targetUrl) {
      addStream({
        server: "ToonWorld Web Player",
        link: targetUrl,
        type: "iframe",
        quality: "720",
        headers: {
          Referer: BASE_URL,
          "User-Agent": commonHeaders["User-Agent"] || "Mozilla/5.0",
        },
      });
    }

    return sortStreams(streamLinks, isDownload);
  } catch (error) {
    if (streamLinks.length > 0) {
      return sortStreams(streamLinks, isDownload);
    }
    // Return fallback stream so the Vega App never fails the stream stage
    return [
      {
        server: "ToonWorld Web Player",
        link: targetUrl || link,
        type: "iframe",
        quality: "720",
        headers: {
          Referer: BASE_URL,
          "User-Agent": commonHeaders["User-Agent"] || "Mozilla/5.0",
        },
      },
    ];
  }
}
