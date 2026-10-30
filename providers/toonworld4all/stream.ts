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
      if (type === "mkv" || type === "mp4") return 6;
      if (type === "embed") return 8;
      return 10;
    } else {
      if (server.includes("toonworld") || type === "embed") return 1;
      if (type === "m3u8") return 2;
      if (server.includes("cf storage")) return 3;
      if (type === "mp4" || type === "mkv") return 4;
      if (server.includes("gofile")) return 5;
      if (server.includes("pixeldrain")) return 6;
      return 10;
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
  try {
    const { axios, cheerio, commonHeaders } = providerContext;
    const abortSignal = signal || new AbortController().signal;
    const streamLinks: Stream[] = [];
    const seen = new Set<string>();

    const addStream = (stream: Stream) => {
      if (!stream || !stream.link || !stream.server || !stream.type) return;
      if (seen.has(stream.link)) return;
      seen.add(stream.link);
      streamLinks.push(stream);
    };

    // If incoming link is already a direct third-party hosting link
    if (link.includes("hubcloud") || link.includes("vcloud")) {
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
      return sortStreams(streamLinks, isDownload);
    }

    if (link.includes("gdflix")) {
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
      return sortStreams(streamLinks, isDownload);
    }

    const targetUrl = new URL(link, `https://${ARCHIVE_HOST}`).href;

    const resolveAndExtractFile = async (
      redirectUrl: string,
      quality?: "360" | "480" | "720" | "1080" | "2160",
      tag?: string,
    ) => {
      try {
        const redRes = await axios.get(redirectUrl, {
          headers: { ...commonHeaders, Referer: targetUrl },
          signal: abortSignal,
          timeout: 7000,
        });
        const redMatch = redRes.data.match(
          /window\.__PROPS__\s*=\s*({[\s\S]*?});/,
        );
        if (!redMatch) return;
        const redProps = safeParseProps(redMatch[1]);
        if (!redProps) return;
        const domain = redProps.link?.domain;
        const hidden = redProps.link?.hidden;
        if (!domain || !hidden) return;

        const hostLink = domain + hidden;
        if (/hubcloud|vcloud/i.test(domain)) {
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
              }
            }
          } catch {
            // Upstream host may be expired or inaccessible
          }
        } else if (/gdflix/i.test(domain)) {
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
              }
            }
          } catch {
            // GDFlix error or WAF
          }
        }
      } catch {
        // Network or timeout error resolving redirect
      }
    };

    // Case 1: link is a direct redirect link
    if (targetUrl.includes("/redirect/")) {
      await resolveAndExtractFile(targetUrl, undefined, undefined);
      return sortStreams(streamLinks, isDownload);
    }

    // Case 2: link is an episode or movie page on archive.toonworld4all.me
    const epRes = await axios.get(targetUrl, {
      headers: { ...commonHeaders, Referer: BASE_URL },
      signal: abortSignal,
    });
    const epHtml = epRes.data;

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

        // 2. Extract resolution encodes and resolve host links
        if (Array.isArray(data?.encodes)) {
          for (const enc of data.encodes) {
            const cleanQuality = normalizeQuality(enc.resolution);
            const codec = enc.readable?.codec;
            if (Array.isArray(enc.files)) {
              for (const file of enc.files) {
                if (file.link) {
                  const redirectUrl = new URL(
                    file.link,
                    `https://${ARCHIVE_HOST}`,
                  ).href;
                  await resolveAndExtractFile(redirectUrl, cleanQuality, codec);
                }
              }
            }
          }
        }
      } catch {
        // Ignore JSON parse errors
      }
    }

    return sortStreams(streamLinks, isDownload);
  } catch (error) {
    throwProviderError("ToonWorld4All", "stream", error);
  }
}
