import { ProviderContext, Stream } from "../types";
import { hubcloudExtractor } from "../extractors/hubcloud";
import { vegadriveExtractor } from "../extractors/vegadrive";
import { throwProviderError } from "../providerErrors";
import { fetchRogWithWAF, normalizeRogLockerUrl } from "./posts";

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
    let hubcloudUrl = link;
    let vegadriveUrl = "";

    if (link.startsWith("{") && link.endsWith("}")) {
      try {
        const parsed = JSON.parse(link);
        if (parsed.hubcloud) hubcloudUrl = normalizeRogLockerUrl(parsed.hubcloud);
        if (parsed.vegadrive) vegadriveUrl = parsed.vegadrive;
      } catch {}
    } else if (link.includes("vegadrive") || link.includes("one.vegadrive")) {
      vegadriveUrl = link;
      hubcloudUrl = "";
    }

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

    if (!hubcloudUrl) {
      if (streamLinks.length > 0) return streamLinks;
    }
    link = hubcloudUrl;

    if (!link.includes("cloud")) {
      try {
        const dotlinkRes = await fetchRogWithWAF(
          link,
          providerContext,
          signal,
        );
        const dotlinkText =
          typeof dotlinkRes.data === "string" ? dotlinkRes.data : "";
        const $ = cheerio.load(dotlinkText);

        // 1. FastDL / G-Direct / Zee-DL (Instant Google CDN stream)
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
                Referer: link,
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
            console.log("FastDL error:", e?.message);
          }
        }

        // 2. V-Drive / VegaDrive
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

        // 3. V-Cloud / Zee-Cloud / HubCloud
        const vcloudAnchor = $(
          "a:contains('V-Cloud'), a:contains('Zee-Cloud'), a:contains('M-Cloud'), a[href*='vcloud'], a[href*='zcloud'], a[href*='hubcloud']",
        ).first();
        const vlink =
          vcloudAnchor.attr("href") ||
          (dotlinkText.match(/<a\s+href="([^"]*cloud\.[^"]*)"/i) || [])[1];
        if (vlink) {
          link = vlink;
        }
      } catch (err: any) {
        console.log("dotlink error:", err?.message);
      }
    }

    if (
      /hubcloud|vcloud|zcloud|oxxfile/i.test(link) &&
      !/mobilejsr|genxfm|nexdrive/i.test(link)
    ) {
      try {
        const hcStreams = await hubcloudExtractor(
          link,
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
      } catch {}
    }

    return streamLinks;
  } catch (error: any) {
    if (streamLinks.length > 0) return streamLinks;
    throwProviderError("LuxMovies", "stream", error);
  }
}
