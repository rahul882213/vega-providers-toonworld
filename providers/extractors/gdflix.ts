import { Stream, ProviderContext } from "../types";
import { gofileExtractor } from "./gofile";

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function isPlayableMediaUrl(
  url: string,
  axios: any,
  headers: Record<string, string>,
  isDownload?: boolean,
): Promise<boolean> {
  if (!url || !url.startsWith("http")) return false;
  if (!isDownload && /\.(zip|rar|7z)(\?|$)/i.test(url)) return false;
  try {
    const res = await axios.get(url, {
      headers: { ...headers, Range: "bytes=0-31" },
      responseType: "stream",
      timeout: 5000,
      maxRedirects: 4,
      validateStatus: () => true,
    });
    if (res?.data && typeof res.data.destroy === "function") {
      try {
        res.data.destroy();
      } catch {}
    }
    const ct = String(res?.headers?.["content-type"] || "").toLowerCase();
    const cd = String(res?.headers?.["content-disposition"] || "").toLowerCase();
    if (!isDownload && (ct.includes("zip") || cd.includes(".zip"))) {
      return false;
    }
    if ((res.status === 200 || res.status === 206) && !ct.includes("text/html")) {
      return true;
    }
    // Some Google CDN links reject Range with 400; retry without Range
    if (res.status === 400 && /googleusercontent|googlevideo/i.test(url)) {
      const res2 = await axios.get(url, {
        headers,
        responseType: "stream",
        timeout: 5000,
        maxRedirects: 4,
        validateStatus: () => true,
      });
      if (res2?.data && typeof res2.data.destroy === "function") {
        try {
          res2.data.destroy();
        } catch {}
      }
      const ct2 = String(res2?.headers?.["content-type"] || "").toLowerCase();
      return (res2.status === 200 || res2.status === 206) && !ct2.includes("text/html");
    }
    return false;
  } catch {
    return false;
  }
}

export async function gdflixExtractor(
  link: string,
  signal: AbortSignal,
  axios: any,
  cheerio: any,
  headers: Record<string, string>,
  providerContext?: ProviderContext,
  isDownload?: boolean,
) {
  try {
    let wafCookies = "";
    let initialRes: any = null;

    try {
      initialRes = await axios.get(link, { headers, signal, timeout: 12000 });
    } catch (error: any) {
      if (
        (error?.response?.status === 403 || error?.response?.status === 503) &&
        providerContext?.openWebView
      ) {
        try {
          const baseUrl = link.split("/").slice(0, 3).join("/");
          const wafResult = await providerContext.openWebView(link, {
            title: "Solve the captcha below and click done",
            description: "Required to bypass GDFlix anti-bot protection.",
            headers: { ...headers, Referer: baseUrl },
            force: true,
            waitForCookie: "cf_clearance",
          });
          wafCookies = wafResult?.cookies || "";
        } catch {
          return [];
        }
      } else {
        throw error;
      }
    }

    if (wafCookies) {
      headers["Cookie"] = wafCookies;
    }

    const streamLinks: Stream[] = [];
    const addStream = (s: Stream) => {
      if (!s.link) return;
      if (!isDownload && /\.(zip|rar|7z)(\?|$)/i.test(s.link)) return;
      if (!streamLinks.some((ex) => ex.link === s.link)) {
        streamLinks.push(s);
      }
    };

    const res = initialRes || (await axios.get(link, { headers, signal, timeout: 12000 }));
    let currentUrl: string =
      res?.request?.res?.responseUrl || res?.config?.url || link;
    let data = res.data;
    let $drive = cheerio.load(data || "");

    // Handle JS redirect if present
    if ($drive("body").attr("onload")?.includes("location.replace")) {
      const newLink = $drive("body")
        .attr("onload")
        ?.split("location.replace('")?.[1]
        ?.split("'")?.[0];
      if (newLink) {
        const resolvedNew = newLink.startsWith("http")
          ? newLink
          : new URL(newLink, currentUrl).href;
        const newRes = await axios.get(resolvedNew, { headers, signal, timeout: 12000 });
        currentUrl =
          newRes?.request?.res?.responseUrl || newRes?.config?.url || resolvedNew;
        $drive = cheerio.load(newRes.data || "");
      }
    }

    const baseUrl = currentUrl.split("/").slice(0, 3).join("/");

    // 1. DIRECT SERVER [MGT] / indexserver direct .mkv / .mp4 links (fastest, direct 206 video/x-matroska)
    try {
      const directEls = $drive(
        "a:contains('DIRECT SERVER'), a:contains('Direct Server'), a[href*='indexserver'], a[href*='GDFS']",
      ).get();
      for (const el of directEls) {
        const rawHref = $drive(el).attr("href") || "";
        if (!rawHref || rawHref.startsWith("#")) continue;
        const fullDirect = rawHref.startsWith("http")
          ? rawHref
          : new URL(rawHref, currentUrl).href;
        if (!isDownload && /\.(zip|rar|7z)(\?|$)/i.test(fullDirect)) continue;
        if (await isPlayableMediaUrl(fullDirect, axios, headers, isDownload)) {
          const ext = fullDirect.includes(".mp4") ? "mp4" : "mkv";
          addStream({
            server: "Direct Server [MGT]",
            link: fullDirect,
            type: ext,
          });
        }
      }
    } catch {}

    // 2. GoFile [Multiup] / Gofile direct mirror
    try {
      const gfAnchorHref =
        $drive(
          "a:contains('GoFile'), a:contains('Gofile'), a[href*='goflix.'], a[href*='gofile.io/d/']",
        )
          .first()
          .attr("href") || "";
      if (gfAnchorHref) {
        const fullGfHref = gfAnchorHref.startsWith("http")
          ? gfAnchorHref
          : new URL(gfAnchorHref, currentUrl).href;
        let gofileId = fullGfHref.match(/gofile\.io\/d\/([a-zA-Z0-9]+)/i)?.[1] || "";
        if (!gofileId && /goflix\.|multiup/i.test(fullGfHref)) {
          const mirrorRes = await axios.get(fullGfHref, {
            headers: { ...headers, Referer: currentUrl },
            signal,
            timeout: 7000,
          });
          const $mirror = cheerio.load(mirrorRes.data || "");
          const innerGf = $mirror("a[href*='gofile.io/d/']").first().attr("href") || "";
          gofileId = innerGf.match(/gofile\.io\/d\/([a-zA-Z0-9]+)/i)?.[1] || "";
        }
        if (gofileId) {
          const gfStream = await gofileExtractor(gofileId, axios, providerContext);
          if (gfStream?.link) {
            addStream({
              server: "Gofile",
              link: gfStream.link,
              type: gfStream.link.includes(".mp4") ? "mp4" : "mkv",
              headers: {
                "User-Agent": headers["User-Agent"] || DEFAULT_UA,
                Referer: "https://gofile.io/",
                Cookie: `accountToken=${gfStream.token}`,
              },
            });
          }
        }
      }
    } catch {}

    // 3. Pixeldrain mirror if present
    try {
      const pxHref =
        $drive("a:contains('Pixeldrain'), a:contains('PixelDrain'), a[href*='pixeldrain']")
          .first()
          .attr("href") || "";
      if (pxHref) {
        const pxId =
          pxHref.match(/\/u\/([a-zA-Z0-9_-]+)/)?.[1] ||
          pxHref.match(/\/file\/([a-zA-Z0-9_-]+)/)?.[1];
        if (pxId) {
          addStream({
            server: "Pixeldrain",
            link: `https://pixeldrain.com/api/file/${pxId}`,
            type: "mkv",
          });
        }
      }
    } catch {}

    // 4. Instant DL / Quick Download (resolve redirect & verify playable media)
    try {
      const seed =
        $drive(
          "a:contains('Instant DL'), a:contains('INSTANT'), a:contains('QUICK DOWNLOAD'), a:contains('Quick Download'), .btn-danger",
        ).attr("href") ||
        $drive("a[href*='instadl'], a[href*='export=download'], a[href*='url=']").attr("href") ||
        "";

      if (seed) {
        const fullSeed = seed.startsWith("http")
          ? seed
          : baseUrl + (seed.startsWith("/") ? "" : "/") + seed;

        let candidateGoogleUrl = "";
        if (fullSeed.includes("url=")) {
          candidateGoogleUrl = decodeURIComponent(fullSeed.split("url=")[1].split("&")[0]);
        } else if (/instadl|fastdl/i.test(fullSeed) || !/\.(mp4|mkv|m3u8)(\?|$)/i.test(fullSeed)) {
          try {
            const vRes = await axios.get(fullSeed, {
              headers: { ...headers, Referer: currentUrl },
              maxRedirects: 0,
              validateStatus: (s: number) => s >= 200 && s < 400,
              signal,
              timeout: 7000,
            });
            const loc = vRes.headers?.location || vRes.headers?.Location || "";
            if (loc.includes("url=")) {
              candidateGoogleUrl = decodeURIComponent(loc.split("url=")[1].split("&")[0]);
            } else if (loc.startsWith("http") && !/pages\.dev|fastdl/i.test(loc)) {
              candidateGoogleUrl = loc;
            }
          } catch {}
        } else {
          candidateGoogleUrl = fullSeed;
        }

        if (
          candidateGoogleUrl &&
          candidateGoogleUrl.startsWith("http") &&
          (await isPlayableMediaUrl(candidateGoogleUrl, axios, headers, isDownload))
        ) {
          addStream({
            server: "Instant Download",
            link: candidateGoogleUrl,
            type: candidateGoogleUrl.includes(".mp4") ? "mp4" : "mkv",
          });
        }
      }
    } catch {}

    // 5. Fast Cloud / ZipDisk / Cloud Resume (exclude .zip archives for video playback)
    try {
      const resumeDrive =
        $drive(
          "a:contains('FAST CLOUD'), a:contains('Fast Cloud'), a:contains('ZIPDISK'), a:contains('CLOUD RESUME'), a:contains('Cloud Resume'), a:contains('RESUME DOWNLOAD'), a[href*='/cloud/'], a[href*='/zfile/']",
        ).attr("href") ||
        $drive(".btn-success, .btn-secondary, a[href*='resume']").attr("href") ||
        "";

      if (resumeDrive) {
        const fullResumeDrive = resumeDrive.startsWith("http")
          ? resumeDrive
          : baseUrl + (resumeDrive.startsWith("/") ? "" : "/") + resumeDrive;

        if (fullResumeDrive.includes("indexbot")) {
          const resumeBotRes = await axios.get(fullResumeDrive, { headers, signal, timeout: 10000 });
          const resumeBotToken = resumeBotRes.data?.match(
            /formData\.append\('token', '([a-f0-9]+)'\)/,
          )?.[1];
          if (resumeBotToken) {
            const resumeBotBody = new FormData();
            resumeBotBody.append("token", resumeBotToken);
            const resumeBotPath = resumeBotRes.data?.match(
              /fetch\('\/download\?id=([a-zA-Z0-9\/+]+)'/,
            )?.[1];
            const resumeBotBaseUrl = fullResumeDrive.split("/download")[0];
            const resumeBotDownload = await fetch(
              resumeBotBaseUrl + "/download?id=" + resumeBotPath,
              {
                method: "POST",
                body: resumeBotBody,
                headers: {
                  Referer: fullResumeDrive,
                  Cookie: "PHPSESSID=7e9658ce7c805dab5bbcea9046f7f308",
                },
              },
            );
            const resumeBotDownloadData = await resumeBotDownload.json();
            if (
              resumeBotDownloadData?.url &&
              (isDownload || !/\.(zip|rar|7z)(\?|$)/i.test(resumeBotDownloadData.url))
            ) {
              addStream({
                server: "ResumeBot",
                link: resumeBotDownloadData.url,
                type: "mkv",
              });
            }
          }
        } else {
          const resumeDriveRes = await axios.get(fullResumeDrive, {
            headers: { ...headers, Referer: currentUrl },
            signal,
            timeout: 10000,
          });
          const resumeDriveHtml = resumeDriveRes.data || "";
          const $resumeDrive = cheerio.load(resumeDriveHtml);
          const resumeLink =
            $resumeDrive(
              "a:contains('Cloud Resume Download'), a:contains('DOWNLOAD'), a:contains('Download'), .btn-success",
            ).attr("href") || "";
          if (resumeLink && !resumeLink.startsWith("#")) {
            const fullResumeLink = resumeLink.startsWith("http")
              ? resumeLink
              : baseUrl + (resumeLink.startsWith("/") ? "" : "/") + resumeLink;
            if (isDownload || !/\.(zip|rar|7z)(\?|$)/i.test(fullResumeLink)) {
              addStream({
                server: "ResumeCloud",
                link: fullResumeLink,
                type: "mkv",
              });
            }
          }
        }
      }
    } catch {}

    return streamLinks;
  } catch {
    return [];
  }
}
