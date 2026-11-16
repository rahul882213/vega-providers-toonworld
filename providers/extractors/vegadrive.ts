import { AxiosInstance } from "axios";
import { ProviderContext, Stream } from "../types";
import { gofileExtractor } from "./gofile";
import { transferitExtractor } from "./transferit";
import { buzzheavierExtractor } from "./buzzheavier";

export async function vegadriveExtractor(
  vegadriveUrl: string,
  axios: AxiosInstance,
  ctx: ProviderContext,
): Promise<Stream[]> {
  const streams: Stream[] = [];
  try {
    const defaultUserAgent =
      ctx?.commonHeaders?.["User-Agent"] ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

    const baseHeaders = {
      "User-Agent": defaultUserAgent,
      Referer: vegadriveUrl,
    };

    let finalUrl = vegadriveUrl;
    let pageRes: any;
    const collectedCookies: string[] = [];

    for (let redirects = 0; ; redirects++) {
      pageRes = await axios.get(finalUrl, {
        headers: baseHeaders,
        maxRedirects: 0,
        validateStatus: (status: number) => status >= 200 && status < 400,
      });

      const cookieHeader: any = pageRes.headers?.["set-cookie"];
      if (Array.isArray(cookieHeader)) {
        for (const c of cookieHeader) {
          const kv = String(c).split(";")[0];
          if (kv && !collectedCookies.includes(kv)) collectedCookies.push(kv);
        }
      } else if (cookieHeader) {
        for (const part of String(cookieHeader).split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
          const kv = part.trim().split(";")[0];
          if (kv && !collectedCookies.includes(kv)) collectedCookies.push(kv);
        }
      }

      const location = pageRes.headers?.location || pageRes.headers?.Location;
      if (![301, 302, 303, 307, 308].includes(pageRes.status) || !location) break;
      if (redirects >= 8) throw new Error("Too many VegaDrive mirror redirects");

      const nextUrl = new URL(String(location), finalUrl);
      if (!["http:", "https:"].includes(nextUrl.protocol)) {
        throw new Error("Invalid VegaDrive mirror redirect");
      }
      finalUrl = nextUrl.href;
    }

    const cookieStr = collectedCookies.join("; ");
    const vdBase = new URL(finalUrl).origin;
    const reqHeaders: Record<string, string> = {
      ...baseHeaders,
      Referer: finalUrl,
      ...(cookieStr ? { Cookie: cookieStr } : {}),
    };

    const shareIdMatch = vegadriveUrl.match(/\/s\/([a-zA-Z0-9]+)/);
    if (!shareIdMatch) return streams;
    const shareId = shareIdMatch[1];

    const targetProviders = ["skydrop", "buzzheavier", "gofile", "pixeldrain", "transferit"];

    await Promise.all(
      targetProviders.map(async (provider) => {
        try {
          const dUrl = `${vdBase}/d/${shareId}/${provider}`;
          if (provider === "skydrop") {
            const sdRes = await axios.get(dUrl, {
              headers: reqHeaders,
              validateStatus: (s: number) => s >= 200 && s < 400,
            });
            const sdHtml = typeof sdRes.data === "string" ? sdRes.data : "";
            const prepMatch = sdHtml.match(/prepareUrl\s*=\s*"([^"]+)"/);
            const linkMatch = sdHtml.match(/linkUrl\s*=\s*"([^"]+)"/);
            if (prepMatch?.[1] && linkMatch?.[1]) {
              const prepUrl = prepMatch[1].replace(/\\\//g, "/");
              const lUrl = linkMatch[1].replace(/\\\//g, "/");
              await axios.get(prepUrl, {
                headers: { ...reqHeaders, Referer: dUrl, Accept: "application/json" },
              });
              const linkRes = await axios.get(lUrl, {
                headers: { ...reqHeaders, Referer: dUrl, Accept: "application/json" },
              });
              const linkData =
                typeof linkRes.data === "string"
                  ? JSON.parse(linkRes.data)
                  : linkRes.data;
              if (linkData?.download_url && typeof linkData.download_url === "string") {
                streams.unshift({
                  server: "VegaDrop (10Gbps Google CDN)",
                  link: linkData.download_url,
                  type: "mkv",
                });
              }
            }
            return;
          }

          const dRes = await axios.get(dUrl, {
            headers: reqHeaders,
            maxRedirects: 0,
            validateStatus: (s: number) => s >= 200 && s < 400,
          });
          let targetLoc: string | undefined =
            dRes.headers?.location || dRes.headers?.Location;
          if (!targetLoc) return;

          if (targetLoc.startsWith("/")) {
            targetLoc = `${vdBase}${targetLoc}`;
          }

          if (targetLoc.includes("__vega_bridge")) {
            const bridgeRes = await axios.get(targetLoc, {
              headers: reqHeaders,
              maxRedirects: 0,
              validateStatus: (s: number) => s >= 200 && s < 400,
            });
            targetLoc = bridgeRes.headers?.location || bridgeRes.headers?.Location;
            if (targetLoc && targetLoc.startsWith("/")) {
              targetLoc = `${vdBase}${targetLoc}`;
            }
          }

          if (!targetLoc) return;

          if (provider === "buzzheavier") {
            const resolved = await buzzheavierExtractor(targetLoc, axios, ctx);
            if (resolved) streams.push(resolved);
          } else if (provider === "pixeldrain") {
            const pxMatch =
              targetLoc.match(/\/u\/([a-zA-Z0-9_-]+)/) ||
              targetLoc.match(/\/file\/([a-zA-Z0-9_-]+)/);
            if (pxMatch) {
              streams.push({
                server: "Pixeldrain",
                link: `https://pixeldrain.com/api/file/${pxMatch[1]}`,
                type: "mp4",
              });
            }
          } else if (provider === "gofile") {
            const gofileMatch = targetLoc.match(/\/d\/([a-zA-Z0-9]+)/);
            if (gofileMatch) {
              const gfStream = await gofileExtractor(gofileMatch[1], axios, ctx);
              if (gfStream && gfStream.link) {
                streams.push({
                  server: "Gofile",
                  link: gfStream.link,
                  type: "mp4",
                  headers: {
                    "User-Agent": defaultUserAgent,
                    Referer: "https://gofile.io/",
                    Cookie: `accountToken=${gfStream.token}`,
                  },
                });
              }
            }
          } else if (provider === "transferit") {
            const trMatch = targetLoc.match(/\/t\/([a-zA-Z0-9_-]+)/);
            if (trMatch) {
              const transferId = trMatch[1];
              const ddl = await transferitExtractor(transferId, axios, defaultUserAgent);
              if (ddl) {
                streams.push({
                  server: "Transfer.it",
                  link: ddl,
                  type: "mp4",
                });
              }
            }
          }
        } catch (err: any) {
          // Ignore host resolution failure
        }
      }),
    );
  } catch (error: any) {
    // Ignore vegadrive page error
  }
  return streams;
}
