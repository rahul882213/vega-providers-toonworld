import { ProviderContext, Stream } from "../types";
import { hubcloudExtractor } from "../extractors/hubcloud";
import { vegadriveExtractor } from "../extractors/vegadrive";
import { throwProviderError } from "../providerErrors";
import { fetchRogWithWAF } from "./posts";

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
  const { axios, cheerio, commonHeaders } = providerContext;
  try {
    const streamLinks: Stream[] = [];
    console.log("dotlink", link);

    let hubcloudUrl = link;
    let vegadriveUrl = "";
    if (link.startsWith("{") && link.endsWith("}")) {
      try {
        const parsed = JSON.parse(link);
        if (parsed.hubcloud) hubcloudUrl = parsed.hubcloud;
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
          for (const s of vdStreams) {
            if (!streamLinks.some((existing) => existing.link === s.link)) {
              streamLinks.push(s);
            }
          }
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

        // 1. FastDL / G-Direct (Instant Google CDN stream)
        const gDirectLink = $(
          "a:contains('G-Direct'), a:contains('Instant'), a[href*='fastdl']",
        ).attr("href");
        if (gDirectLink) {
          try {
            const fastdlRes = await axios.get(gDirectLink, {
              headers: { ...commonHeaders, Referer: link },
              signal,
              timeout: 10000,
            });
            const m = String(fastdlRes.data || "").match(
              /reurl\s*=\s*["']([^"']+)["']/,
            );
            if (m) {
              const targetUrl = m[1].includes("link=")
                ? decodeURIComponent(m[1].split("link=")[1])
                : m[1];
              if (
                targetUrl.includes("googleusercontent.com") ||
                targetUrl.startsWith("http")
              ) {
                streamLinks.push({
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

        // 2. VegaDrive
        const pageVdLink = $(
          "a:contains('Vega Drive'), a[href*='vegadrive']",
        ).attr("href");
        if (pageVdLink) {
          try {
            const vdStreams = await vegadriveExtractor(
              pageVdLink,
              axios,
              providerContext,
            );
            if (Array.isArray(vdStreams)) {
              for (const s of vdStreams) {
                if (!streamLinks.some((existing) => existing.link === s.link)) {
                  streamLinks.push(s);
                }
              }
            }
          } catch (e: any) {
            console.log("vegadrive dotlink error:", e?.message);
          }
        }

        // 3. V-Cloud / HubCloud
        const vcloudAnchor = $(
          "a:contains('V-Cloud'), a:contains('M-Cloud'), a[href*='vcloud'], a[href*='hubcloud']",
        );
        const vlink =
          vcloudAnchor.attr("href") ||
          (dotlinkText.match(/<a\s+href="([^"]*cloud\.[^"]*)"/i) || [])[1];
        if (vlink) {
          link = vlink;
        }

        // 4. Filepress link
        try {
          const filepressAnchor = $(
            '.btn.btn-sm.btn-outline[style*="rgb(252,185,0)"], a:contains("Filepress"), a[href*="filepress"], a[href*="filebee"]',
          ).first();
          const filepressLink =
            filepressAnchor.attr("href") ||
            filepressAnchor.parent().attr("href");
          if (filepressLink) {
            const filepressID = filepressLink.split("/").pop();
            const filepressBaseUrl = filepressLink
              .split("/")
              .slice(0, -2)
              .join("/");
            const filepressTokenRes = await axios.post(
              filepressBaseUrl + "/api/file/downlaod/",
              {
                id: filepressID,
                method: "indexDownlaod",
                captchaValue: null,
              },
              {
                headers: {
                  "Content-Type": "application/json",
                  Referer: filepressBaseUrl,
                },
                timeout: 10000,
              },
            );
            if (filepressTokenRes.data?.status) {
              const filepressToken = filepressTokenRes.data?.data;
              const filepressStreamLink = await axios.post(
                filepressBaseUrl + "/api/file/downlaod2/",
                {
                  id: filepressToken,
                  method: "indexDownlaod",
                  captchaValue: null,
                },
                {
                  headers: {
                    "Content-Type": "application/json",
                    Referer: filepressBaseUrl,
                  },
                  timeout: 10000,
                },
              );
              if (filepressStreamLink.data?.data?.[0]) {
                streamLinks.push({
                  server: "filepress",
                  link: filepressStreamLink.data.data[0],
                  type: "mkv",
                });
              }
            }
          }
        } catch (error) {
          console.log("filepress error: ");
        }
      } catch (err: any) {
        console.log("dotlink error:", err?.message);
      }
    }

    const hcStreams = await hubcloudExtractor(
      link,
      signal,
      axios,
      cheerio,
      commonHeaders,
      providerContext,
      isDownload,
      "luxMovies",
    );
    if (Array.isArray(hcStreams)) {
      for (const s of hcStreams) {
        if (!streamLinks.some((existing) => existing.link === s.link)) {
          streamLinks.push(s);
        }
      }
    }

    return streamLinks;
  } catch (error: any) {
    throwProviderError("LuxMovies", "stream", error);
  }
}
