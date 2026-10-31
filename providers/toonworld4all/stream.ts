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
    if (isDownload) {
      if (server.includes("cf storage") || server.includes("storage")) return 1;
      if (server.includes("gdrive") || server.includes("google")) return 2;
      if (server.includes("pixeldrain")) return 3;
      if (server.includes("gofile")) return 4;
      if (server.includes("fastdl")) return 5;
      if (server.includes("hubcdn")) return 6;
      if (type === "mkv" || type === "mp4") return 7;
      if (server.includes("toonworld player")) return 8;
      if (server.includes("web mirror") || type === "embed") return 50;
      return 20;
    } else {
      // If direct web player from data.streams is present
      if (server === "toonworld player") return 1;
      // Direct high-performance video streams for ExoPlayer
      if (type === "m3u8") return 2;
      if (server.includes("cf storage") || server.includes("storage")) return 3;
      if (server.includes("cf worker") || server.includes("fast cloud")) return 4;
      if (server.includes("pixeldrain")) return 5;
      if (server.includes("gofile")) return 6;
      if (server.includes("fastdl") || server.includes("fsl")) return 7;
      if (server.includes("hubcdn")) return 8;
      if (type === "mp4" || type === "mkv") return 9;
      if (server.includes("gdrive") || server.includes("google")) return 15;
      // Webpage mirrors / embeds rank at the very bottom so ExoPlayer never plays an HTML page
      if (server.includes("web mirror") || type === "embed") return 99;
      return 20;
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
          type: "embed",
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
          type: "embed",
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
            if (Array.isArray(hcStreams)) {
              for (const s of hcStreams) {
                addStream({
                  ...s,
                  quality: s.quality || quality,
                  tag: s.tag || tag,
                });
                extractedCount++;
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

        // If direct extractor did not return streams, add host link as low-priority embed server (exclude unplayable lockers like mega.nz)
        if (extractedCount === 0 && hostLink.startsWith("http") && !hostLink.includes("mega.nz") && !hostLink.includes("filepress")) {
          addStream({
            server: `ToonWorld Web Mirror (${quality || "HD"} - ${hostName || "Cloud"})`,
            link: hostLink,
            type: "embed",
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
          server: "ToonWorld Web Mirror",
          link: targetUrl,
          type: "embed",
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
    try {
      const epRes = await axios.get(targetUrl, {
        headers: {
          ...commonHeaders,
          Referer: BASE_URL,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: abortSignal,
        timeout: 10000,
      });
      epHtml = epRes.data || "";
    } catch (fetchErr) {
      console.warn("Failed to fetch archive page:", fetchErr);
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
                      : "embed";

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

          // 2. Extract resolution encodes and resolve host links in parallel
          if (Array.isArray(data?.encodes)) {
            const tasks: Promise<any>[] = [];
            for (const enc of data.encodes) {
              const cleanQuality = normalizeQuality(enc.resolution);
              const codec = enc.readable?.codec;
              if (Array.isArray(enc.files)) {
                // Prioritize HubCloud and GDFlix which return direct .mkv streams
                const sortedFiles = [...enc.files].sort((a, b) => {
                  const aText = ((a.host || "") + (a.short || "")).toLowerCase();
                  const bText = ((b.host || "") + (b.short || "")).toLowerCase();
                  const aScore = /hubcloud|vcloud|gdflix|pixel/i.test(aText) ? 0 : 1;
                  const bScore = /hubcloud|vcloud|gdflix|pixel/i.test(bText) ? 0 : 1;
                  return aScore - bScore;
                });

                for (const file of sortedFiles) {
                  const hName = (file.host || file.short || "").toLowerCase();
                  // Skip lockers that do not support direct streaming in ExoPlayer
                  if (hName.includes("mega") || hName.includes("filepress")) continue;

                  if (file.link) {
                    const redirectUrl = new URL(
                      file.link,
                      `https://${ARCHIVE_HOST}`,
                    ).href;
                    const hostLabel = file.host || file.short || "Cloud";
                    tasks.push(
                      resolveAndExtractFile(
                        redirectUrl,
                        cleanQuality,
                        codec,
                        hostLabel,
                      ),
                    );
                  }
                }
              }
            }

            if (tasks.length > 0) {
              let timer: any;
              const timeoutPromise = new Promise((res) => {
                timer = setTimeout(res, 15000);
              });
              await Promise.race([Promise.allSettled(tasks), timeoutPromise]);
              if (timer) clearTimeout(timer);
            }
          }
        } catch {
          // Ignore JSON parse errors
        }
      }
    }

    // Fallback: if no direct streams or extractors succeeded, guarantee fallback URL
    if (streamLinks.length === 0 && targetUrl) {
      addStream({
        server: "ToonWorld Web Mirror",
        link: targetUrl,
        type: "embed",
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
        server: "ToonWorld Web Mirror",
        link: targetUrl || link,
        type: "embed",
        quality: "720",
        headers: {
          Referer: BASE_URL,
          "User-Agent": commonHeaders["User-Agent"] || "Mozilla/5.0",
        },
      },
    ];
  }
}
