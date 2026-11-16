import { Stream, ProviderContext } from "../types";

export async function gdflixExtractor(
  link: string,
  signal: AbortSignal,
  axios: any,
  cheerio: any,
  headers: Record<string, string>,
  providerContext?: ProviderContext,
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
        } catch (wafErr) {
          // User cancelled WAF dialog or WebView unavailable
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
      if (s.link && !streamLinks.some((ex) => ex.link === s.link)) {
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

    // 1. Instant DL / Quick Download
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

        if (fullSeed.includes("url=")) {
          const directPart = decodeURIComponent(fullSeed.split("url=")[1].split("&")[0]);
          if (directPart && directPart.startsWith("http")) {
            addStream({ server: "Instant Download", link: directPart, type: "mkv" });
          }
        } else if (
          /\.(mp4|mkv|m3u8)(\?|$)/i.test(fullSeed) ||
          /instadl|workers\.dev|googleusercontent\.com|r2\.cloudflarestorage/i.test(fullSeed) ||
          fullSeed.includes("?bytes=")
        ) {
          addStream({ server: "Instant Download", link: fullSeed, type: "mkv" });
        } else {
          try {
            const vRes = await axios.get(fullSeed, {
              headers: { ...headers, Referer: currentUrl },
              maxRedirects: 0,
              validateStatus: (s: number) => s >= 200 && s < 400,
              signal,
              timeout: 10000,
            });
            const loc = vRes.headers?.location;
            if (loc) {
              let directGoogleUrl: string | null = null;
              if (loc.includes("url=")) {
                directGoogleUrl = decodeURIComponent(loc.split("url=")[1].split("&")[0]);
              } else if (loc.startsWith("http")) {
                directGoogleUrl = loc;
              }
              if (directGoogleUrl && directGoogleUrl.startsWith("http")) {
                addStream({ server: "Instant Download", link: directGoogleUrl, type: "mkv" });
              }
            }
          } catch {}
        }
      }
    } catch {}

    // 2. Fast Cloud / ZipDisk / Cloud Resume
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
            if (resumeBotDownloadData?.url) {
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
            addStream({
              server: "ResumeCloud",
              link: fullResumeLink,
              type: "mkv",
            });
          }
        }
      }
    } catch {}

    return streamLinks;
  } catch (error) {
    return [];
  }
}
