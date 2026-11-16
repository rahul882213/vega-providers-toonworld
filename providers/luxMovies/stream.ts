import { ProviderContext, Stream } from "../types";
import { hubcloudExtractor } from "../extractors/hubcloud";
import { vegadriveExtractor } from "../extractors/vegadrive";
import { gdflixExtractor } from "../extractors/gdflix";
import { throwProviderError } from "../providerErrors";
import { fetchRogWithWAF, normalizeRogLockerUrl } from "./posts";

async function extractZeeDl(
  gDirectLink: string,
  referer: string,
  axios: any,
  commonHeaders: Record<string, string>,
  signal: AbortSignal,
): Promise<Stream | null> {
  try {
    const fastdlRes = await axios.get(gDirectLink, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        ...commonHeaders,
        Referer: referer,
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
        return {
          server: "Instant (Google CDN)",
          link: targetUrl,
          type: "mkv",
        };
      }
    }
  } catch (e: any) {
    console.log("FastDL error:", e?.message);
  }
  return null;
}

export async function getStream({
  link: rawLink,
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
  const { axios, cheerio, commonHeaders } = providerContext;
  let link = normalizeRogLockerUrl(rawLink.split("#")[0]);
  const streamLinks: Stream[] = [];

  const addStream = (s: Stream) => {
    if (s.link && !streamLinks.some((existing) => existing.link === s.link)) {
      streamLinks.push(s);
    }
  };

  try {
    let gdirectUrl = "";
    let vegadriveUrl = "";
    let hubcloudUrl = "";
    let gdflixUrl = "";
    let nexdriveUrl = "";

    if (link.startsWith("{") && link.endsWith("}")) {
      try {
        const parsed = JSON.parse(link);
        if (parsed.gdirect) gdirectUrl = normalizeRogLockerUrl(parsed.gdirect);
        if (parsed.vegadrive) vegadriveUrl = normalizeRogLockerUrl(parsed.vegadrive);
        if (parsed.hubcloud) hubcloudUrl = normalizeRogLockerUrl(parsed.hubcloud);
        if (parsed.gdflix) gdflixUrl = normalizeRogLockerUrl(parsed.gdflix);
        if (parsed.nexdrive) nexdriveUrl = normalizeRogLockerUrl(parsed.nexdrive);
      } catch {}
    } else if (link.includes("vegadrive") || link.includes("one.vegadrive")) {
      vegadriveUrl = link;
    } else if (link.includes("zee-dl") || link.includes("fastdl")) {
      gdirectUrl = link;
    } else if (link.includes("gdflix")) {
      gdflixUrl = link;
    } else if (/vcloud|zcloud|hubcloud|oxxfile/i.test(link)) {
      hubcloudUrl = link;
    } else if (/nexdrive|genxfm|mobilejsr/i.test(link)) {
      nexdriveUrl = link;
    }

    // 1. Instant (Google CDN) from Zee-DL / FastDL
    if (gdirectUrl) {
      try {
        const s = await extractZeeDl(
          gdirectUrl,
          "https://nexdrive.store/",
          axios,
          commonHeaders,
          signal,
        );
        if (s) addStream(s);
      } catch (e: any) {
        console.log("gdirect error:", e?.message);
      }
    }

    // 2. VegaDrive (VegaDrop 10Gbps CDN, Transfer.it, Gofile, Pixeldrain)
    if (vegadriveUrl) {
      try {
        const vdStreams = await vegadriveExtractor(
          vegadriveUrl,
          axios,
          providerContext,
        );
        if (Array.isArray(vdStreams)) {
          for (const s of vdStreams) addStream(s);
        }
      } catch (e: any) {
        console.log("vegadrive error:", e?.message);
      }
    }

    // 3. GDFlix (Direct Server [MGT], Gofile, Pixeldrain)
    if (gdflixUrl) {
      try {
        const gd = await gdflixExtractor(
          gdflixUrl,
          signal,
          axios,
          cheerio,
          commonHeaders,
          streamLinks.length > 0
            ? { ...providerContext, openWebView: undefined as any }
            : providerContext,
        );
        if (Array.isArray(gd)) {
          for (const s of gd) addStream(s);
        }
      } catch (e: any) {
        console.log("gdflix error:", e?.message);
      }
    }

    // 4. HubCloud (CF Storage, Pixeldrain, GDrive)
    if (hubcloudUrl && !/mobilejsr|genxfm|nexdrive/i.test(hubcloudUrl)) {
      try {
        const hcStreams = await hubcloudExtractor(
          hubcloudUrl,
          signal,
          axios,
          cheerio,
          commonHeaders,
          streamLinks.length > 0
            ? { ...providerContext, openWebView: undefined as any }
            : providerContext,
          isDownload,
          "luxMovies",
        );
        if (Array.isArray(hcStreams)) {
          for (const s of hcStreams) addStream(s);
        }
      } catch (e: any) {
        console.log("hubcloud error:", e?.message);
      }
    }

    // 5. Page resolution for NexDrive / GenXfm / locker intermediate pages
    const pageToFetch =
      nexdriveUrl ||
      (!link.startsWith("{") &&
      !/vcloud|zcloud|hubcloud|oxxfile|vegadrive|zee-dl|fastdl|gdflix/i.test(link)
        ? link
        : "");

    if (pageToFetch) {
      try {
        const dotlinkRes = await fetchRogWithWAF(
          pageToFetch,
          providerContext,
          signal,
        );
        const dotlinkText =
          typeof dotlinkRes.data === "string" ? dotlinkRes.data : "";
        const $ = cheerio.load(dotlinkText);

        // A. Direct locker links right on page
        $("a[href]").each((_, a) => {
          const href = $(a).attr("href") || "";
          if (
            href.includes("pixeldrain.com/u/") ||
            href.includes("pixeldrain.com/api/file/")
          ) {
            const pxId = href.split("/").pop();
            if (pxId) {
              addStream({
                server: "Pixeldrain",
                link: `https://pixeldrain.com/api/file/${pxId}`,
                type: "mp4",
              });
            }
          }
        });

        // B. FastDL / G-Direct / Zee-DL
        const gDirectLink = $(
          "a:contains('G-Direct'), a:contains('Instant'), a[href*='zee-dl'], a[href*='fastdl']",
        )
          .first()
          .attr("href");
        if (gDirectLink) {
          const s = await extractZeeDl(
            gDirectLink,
            pageToFetch,
            axios,
            commonHeaders,
            signal,
          );
          if (s) addStream(s);
        }

        // C. V-Drive / VegaDrive (high reliability)
        const pageVdLink = $(
          "a:contains('V-Drive'), a:contains('Vega Drive'), a[href*='vegadrive']",
        )
          .first()
          .attr("href");
        if (pageVdLink) {
          try {
            const vdStreams = await vegadriveExtractor(
              pageVdLink,
              axios,
              providerContext,
            );
            if (Array.isArray(vdStreams)) {
              for (const s of vdStreams) addStream(s);
            }
          } catch (e: any) {
            console.log("vegadrive dotlink error:", e?.message);
          }
        }

        // D. GDFlix
        const gdLink = $("a[href*='gdflix']").first().attr("href");
        if (gdLink) {
          try {
            const gd = await gdflixExtractor(
              gdLink,
              signal,
              axios,
              cheerio,
              commonHeaders,
              { ...providerContext, openWebView: undefined as any },
            );
            if (Array.isArray(gd)) {
              for (const s of gd) addStream(s);
            }
          } catch {}
        }

        // E. V-Cloud / Zee-Cloud / HubCloud
        const vcloudAnchor = $(
          "a:contains('V-Cloud'), a:contains('Zee-Cloud'), a:contains('M-Cloud'), a[href*='vcloud'], a[href*='zcloud'], a[href*='hubcloud']",
        ).first();
        const vlink =
          vcloudAnchor.attr("href") ||
          (dotlinkText.match(/<a\s+href="([^"]*cloud\.[^"]*)"/i) || [])[1];
        if (vlink && !/mobilejsr|genxfm|nexdrive/i.test(vlink)) {
          try {
            const hcStreams = await hubcloudExtractor(
              vlink,
              signal,
              axios,
              cheerio,
              commonHeaders,
              { ...providerContext, openWebView: undefined as any },
              isDownload,
              "luxMovies",
            );
            if (Array.isArray(hcStreams)) {
              for (const s of hcStreams) addStream(s);
            }
          } catch {}
        }
      } catch (err: any) {
        console.log("dotlink error:", err?.message);
      }
    }

    return streamLinks;
  } catch (error: any) {
    if (streamLinks.length > 0) return streamLinks;
    throwProviderError("LuxMovies", "stream", error);
  }
}
