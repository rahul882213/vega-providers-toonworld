import { Stream, ProviderContext } from "../types";
import { hubcloudExtractor } from "../extractors/hubcloud";
import { gdflixExtractor } from "../extractors/gdflix";

const defaultHeaders: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const normalizeQuality = (qual?: string): string => {
  if (!qual) return "720";
  const m = qual.match(/\b(2160|1080|720|480|360)\b/);
  return m ? m[1] : "720";
};

const sortStreams = (streams: Stream[], isDownload?: boolean): Stream[] => {
  return [...streams].sort((a, b) => {
    const sA = (a.server || "").toLowerCase();
    const sB = (b.server || "").toLowerCase();

    if (isDownload) {
      // Prioritize download-optimized lockers
      const aIsDl = /fromsmash|multiup|gdrive|fastdl|direct|download/i.test(sA);
      const bIsDl = /fromsmash|multiup|gdrive|fastdl|direct|download/i.test(sB);
      if (aIsDl && !bIsDl) return -1;
      if (!aIsDl && bIsDl) return 1;
    } else {
      // Prioritize fast streaming servers
      const aIsFast = /direct|fastdl|stream|gdrive/i.test(sA);
      const bIsFast = /direct|fastdl|stream|gdrive/i.test(sB);
      if (aIsFast && !bIsFast) return -1;
      if (!aIsFast && bIsFast) return 1;
    }

    const qA = parseInt(normalizeQuality(a.quality), 10);
    const qB = parseInt(normalizeQuality(b.quality), 10);
    return qB - qA;
  });
};

export const unlockLinksmod = async function (
  url: string,
  axios: any,
  cheerio: any,
  commonHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<{ server: string; link: string; type: string }[]> {
  const extracted: { server: string; link: string; type: string }[] = [];

  try {
    const res1 = await axios.get(url, {
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: "https://bollyflix.church/",
      },
      signal,
      timeout: 10000,
    });

    const $1 = cheerio.load(res1.data);
    const input = $1("form input[type=hidden]");
    const name = input.attr("name");
    const val = input.attr("value");

    let postHtml = res1.data;

    if (name && val) {
      const cookieHeader = res1.headers?.["set-cookie"]
        ? Array.isArray(res1.headers["set-cookie"])
          ? res1.headers["set-cookie"].map((c: string) => c.split(";")[0]).join("; ")
          : res1.headers["set-cookie"]
        : "";

      const body = new URLSearchParams();
      body.append(name, val);

      const res2 = await axios.post(url, body.toString(), {
        headers: {
          ...defaultHeaders,
          ...commonHeaders,
          Referer: url,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: cookieHeader,
        },
        signal,
        timeout: 12000,
      });

      postHtml = res2.data;
    }

    const $2 = cheerio.load(postHtml);
    $2("a").each((_: number, el: any) => {
      const href = $2(el).attr("href");
      if (!href || !href.startsWith("http")) return;
      if (href.includes("bollyflix") || href.includes("linksmod.top")) return;

      let server = "Cloud Storage";
      let extType = "mkv";

      if (href.includes("fromsmash.com")) {
        server = "FromSmash";
      } else if (href.includes("dgdrive.xyz")) {
        server = "DGDrive";
      } else if (href.includes("multiup.org")) {
        server = "MultiUp";
      } else if (href.includes("send.cm")) {
        server = "Send.cm";
      } else if (href.includes("uptobox.com")) {
        server = "UptoBox";
      } else if (href.includes("pandafiles.com")) {
        server = "PandaFiles";
      } else if (href.includes("desiupload.co")) {
        server = "DesiUpload";
      } else if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(href)) {
        server = "Direct Link";
        extType = href.includes(".m3u8") ? "m3u8" : href.includes(".mp4") ? "mp4" : "mkv";
      }

      if (!extracted.some((e) => e.link === href)) {
        extracted.push({ server, link: href, type: extType });
      }
    });
  } catch (err) {
    console.warn("Linksmod unlock error:", err);
  }

  return extracted;
};

export const getStream = async function ({
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
}): Promise<Stream[]> {
  const { axios, cheerio, commonHeaders, openWebView } = providerContext;
  const streamLinks: Stream[] = [];

  const addStream = (s: Stream) => {
    if (s.link && !streamLinks.some((existing) => existing.link === s.link)) {
      streamLinks.push({
        ...s,
        quality: s.quality || "720",
        type: s.type || "mkv",
      });
    }
  };

  try {
    let targetUrl = link;

    // 1. If link is fxlinks.rest, fetch to extract the first episode/download destination
    if (targetUrl.includes("fxlinks.rest")) {
      try {
        const fxRes = await axios.get(targetUrl, {
          headers: {
            ...defaultHeaders,
            ...commonHeaders,
            Referer: "https://bollyflix.church/",
          },
          signal,
          timeout: 10000,
        });
        const $fx = cheerio.load(fxRes.data);
        const epLink = $fx("a[href*='fastdl'], a[href*='linksmod'], a[href*='drive']").first().attr("href");
        if (epLink) {
          targetUrl = epLink;
        }
      } catch {}
    }

    // 2. LinksMod Resolver (Direct Locker links)
    if (targetUrl.includes("linksmod.top")) {
      const unlocked = await unlockLinksmod(targetUrl, axios, cheerio, commonHeaders, signal);
      for (const u of unlocked) {
        addStream({
          server: u.server,
          link: u.link,
          type: u.type,
          quality: "720",
          headers: {
            Referer: targetUrl,
            "User-Agent": commonHeaders["User-Agent"] || defaultHeaders["User-Agent"],
          },
        });
      }
    }

    // 3. FastDL (Google Drive / Fast Server)
    if (targetUrl.includes("fastdlserver.site") || targetUrl.includes("fastdl")) {
      let resolvedFastDl = false;

      // Try openWebView solver if available to bypass Cloudflare Turnstile
      if (openWebView) {
        try {
          const waf = await openWebView(targetUrl, {
            title: "Resolving FastDL Google Drive Stream",
            description: "Please complete the verification if prompted.",
            headers: {
              ...defaultHeaders,
              ...commonHeaders,
              Referer: "https://bollyflix.church/",
            },
            waitForCookie: "cf_clearance",
            force: true,
          });

          if (waf.url && waf.url !== targetUrl && !waf.url.includes("fastdlserver.site")) {
            targetUrl = waf.url;
            resolvedFastDl = true;
          } else if (waf.data) {
            const $w = cheerio.load(waf.data);
            const direct = $w("a#downloadBtn, a.btn-success, a.btn-primary, a[href*='drive.google.com'], a[href*='hubcloud']").first().attr("href");
            if (direct && direct.startsWith("http")) {
              targetUrl = direct;
              resolvedFastDl = true;
            }
          }
        } catch (wafErr) {
          console.warn("FastDL openWebView error:", wafErr);
        }
      }

      // If not redirected, still add FastDL as a primary fast download server
      addStream({
        server: "FastDL (Google Drive)",
        link: targetUrl,
        type: "mkv",
        quality: "720",
        headers: {
          Referer: "https://bollyflix.church/",
          "User-Agent": commonHeaders["User-Agent"] || defaultHeaders["User-Agent"],
        },
      });
    }

    // 4. HubCloud Extractor
    if (/hubcloud|vcloud/i.test(targetUrl)) {
      try {
        const hcStreams = await hubcloudExtractor(
          targetUrl,
          signal,
          axios,
          cheerio,
          {
            ...defaultHeaders,
            ...commonHeaders,
            Referer: targetUrl,
          },
          providerContext,
          isDownload,
          "bollyflix",
        );
        if (Array.isArray(hcStreams)) {
          for (const s of hcStreams) addStream(s);
        }
      } catch {}
    }

    // 5. GDFlix Extractor
    if (/gdflix/i.test(targetUrl)) {
      try {
        const gdStreams = await gdflixExtractor(
          targetUrl,
          signal,
          axios,
          cheerio,
          {
            ...defaultHeaders,
            ...commonHeaders,
            Referer: targetUrl,
          },
          providerContext,
        );
        if (Array.isArray(gdStreams)) {
          for (const s of gdStreams) addStream(s);
        }
      } catch {}
    }

    // 6. Direct media links (.mp4, .mkv, .m3u8)
    if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(targetUrl)) {
      const ext = targetUrl.includes(".m3u8") ? "m3u8" : targetUrl.includes(".mp4") ? "mp4" : "mkv";
      addStream({
        server: "Direct Stream",
        link: targetUrl,
        type: ext,
        quality: "720",
        headers: {
          Referer: "https://bollyflix.church/",
        },
      });
    }

    // Fallback: Ensure at least one stream is always returned to prevent Vega App errors
    if (streamLinks.length === 0 && targetUrl) {
      addStream({
        server: "BollyFlix Player",
        link: targetUrl,
        type: "iframe",
        quality: "720",
        headers: {
          Referer: "https://bollyflix.church/",
          "User-Agent": commonHeaders["User-Agent"] || defaultHeaders["User-Agent"],
        },
      });
    }

    return sortStreams(streamLinks, isDownload);
  } catch (err) {
    if (streamLinks.length > 0) {
      return sortStreams(streamLinks, isDownload);
    }
    return [
      {
        server: "BollyFlix Player",
        link: link,
        type: "iframe",
        quality: "720",
        headers: {
          Referer: "https://bollyflix.church/",
        },
      },
    ];
  }
};
