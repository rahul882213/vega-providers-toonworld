import { throwProviderError } from "../providerErrors";

export async function gdflixExtractor(
  link: string,
  signal: AbortSignal,
  axios: any,
  cheerio: any,
  headers: Record<string, string>,
  providerContext?: any,
) {
  try {
    let wafCookies: string | undefined;
    try {
      await axios.get(link, { headers, signal });
    } catch (error: any) {
      if (error.response?.status === 403 && providerContext?.openWebView) {
        console.log("gdflix: WAF detected (403), using solver...");
        const baseUrl = link.split("/").slice(0, 3).join("/");
        const wafResult = await providerContext.openWebView(link, {
          title: "Solve the captcha below and click done",
          description: "Required to bypass GDFlix anti-bot protection.",
          headers: { ...headers, Referer: baseUrl },
          force: true,
          waitForCookie: "cf_clearance",
        });
        wafCookies = wafResult.cookies;
      } else {
        throw error;
      }
    }

    if (wafCookies) {
      headers["Cookie"] = wafCookies;
    }

    const streamLinks: any[] = [];
    const res = await axios(`${link}`, { headers, signal });
    console.log("gdflixExtractor", link);
    const data = res.data;
    let $drive = cheerio.load(data);
    // handle if redirected to another link

    if ($drive("body").attr("onload")?.includes("location.replace")) {
      const newLink = $drive("body")
        .attr("onload")
        ?.split("location.replace('")?.[1]
        .split("'")?.[0];

      console.log("newLink", newLink);
      if (newLink) {
        const newRes = await axios.get(newLink, { headers, signal });
        $drive = cheerio.load(newRes.data);
      }
    }

    // try {
    //   const resumeBot = $drive('.fab.fa-artstation').prev().attr('href') || '';
    //   console.log('resumeBot', resumeBot);
    //   const resumeBotRes = await axios.get(resumeBot, {headers});
    //   const resumeBotToken = resumeBotRes.data.match(
    //     /formData\.append\('token', '([a-f0-9]+)'\)/,
    //   )[1];
    //   const resumeBotBody = new FormData();
    //   resumeBotBody.append('token', resumeBotToken);
    //   const resumeBotPath = resumeBotRes.data.match(
    //     /fetch\('\/download\?id=([a-zA-Z0-9\/+]+)'/,
    //   )[1];
    //   const resumeBotBaseUrl = resumeBot.split('/download')[0];
    //   // console.log(
    //   //   'resumeBotPath',
    //   //   resumeBotBaseUrl + '/download?id=' + resumeBotPath,
    //   // );
    //   // console.log('resumeBotBody', resumeBotToken);

    //   const resumeBotDownload = await fetch(
    //     resumeBotBaseUrl + '/download?id=' + resumeBotPath,
    //     {
    //       method: 'POST',
    //       body: resumeBotBody,
    //       headers: {
    //         Referer: resumeBot,
    //         Cookie: 'PHPSESSID=7e9658ce7c805dab5bbcea9046f7f308',
    //       },
    //     },
    //   );
    //   const resumeBotDownloadData = await resumeBotDownload.json();
    //   console.log('resumeBotDownloadData', resumeBotDownloadData.url);
    //   streamLinks.push({
    //     server: 'ResumeBot',
    //     link: resumeBotDownloadData.url,
    //     type: 'mkv',
    //   });
    // } catch (err) {
    //   console.log('ResumeBot link not found', err);
    // }

    /// resume cloud
    try {
      const baseUrl = link.split("/").slice(0, 3).join("/");
      const resumeDrive =
        $drive("a:contains('CLOUD RESUME'), a:contains('Cloud Resume'), a:contains('RESUME DOWNLOAD')").attr("href") ||
        $drive(".btn-success, .btn-secondary, a[href*='resume']").attr("href") ||
        "";
      console.log("resumeDrive", resumeDrive);
      if (resumeDrive) {
        const fullResumeDrive = resumeDrive.startsWith("http")
          ? resumeDrive
          : baseUrl + (resumeDrive.startsWith("/") ? "" : "/") + resumeDrive;

        if (fullResumeDrive.includes("indexbot")) {
          const resumeBotRes = await axios.get(fullResumeDrive, { headers });
          const resumeBotToken = resumeBotRes.data.match(
            /formData\.append\('token', '([a-f0-9]+)'\)/,
          )?.[1];
          if (resumeBotToken) {
            const resumeBotBody = new FormData();
            resumeBotBody.append("token", resumeBotToken);
            const resumeBotPath = resumeBotRes.data.match(
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
              streamLinks.push({
                server: "ResumeBot",
                link: resumeBotDownloadData.url,
                type: "mkv",
              });
            }
          }
        } else {
          const resumeDriveRes = await axios.get(fullResumeDrive, { headers });
          const resumeDriveHtml = resumeDriveRes.data;
          const $resumeDrive = cheerio.load(resumeDriveHtml);
          const resumeLink =
            $resumeDrive("a:contains('DOWNLOAD'), a:contains('Download'), .btn-success").attr("href");
          if (resumeLink) {
            const fullResumeLink = resumeLink.startsWith("http")
              ? resumeLink
              : baseUrl + (resumeLink.startsWith("/") ? "" : "/") + resumeLink;
            streamLinks.push({
              server: "ResumeCloud",
              link: fullResumeLink,
              type: "mkv",
            });
          }
        }
      }
    } catch (err) {
      console.log("Resume link not found", err);
    }

    //instant link / quick download
    try {
      const baseUrl = link.split("/").slice(0, 3).join("/");
      const seed =
        $drive("a:contains('QUICK DOWNLOAD'), a:contains('Quick Download'), a:contains('INSTANT'), .btn-danger").attr("href") ||
        $drive("a[href*='export=download'], a[href*='url=']").attr("href") ||
        "";

      if (seed) {
        const fullSeed = seed.startsWith("http")
          ? seed
          : baseUrl + (seed.startsWith("/") ? "" : "/") + seed;

        if (fullSeed.includes("url=")) {
          const directPart = decodeURIComponent(fullSeed.split("url=")[1]);
          if (directPart && directPart.startsWith("http")) {
            streamLinks.push({ server: "Instant Download", link: directPart, type: "mkv" });
          }
        }

        if (/\.(mp4|mkv|m3u8)(\?|$)/i.test(fullSeed) || fullSeed.includes("workers.dev")) {
          streamLinks.push({ server: "Instant Download", link: fullSeed, type: "mkv" });
        }

        try {
          const vRes = await axios.get(seed, {
            headers: { ...headers, Referer: link },
            maxRedirects: 0,
            validateStatus: (s: number) => s >= 200 && s < 400,
            signal,
          });

          const loc = vRes.headers?.location;
          if (loc) {
            let directGoogleUrl: string | null = null;
            if (loc.includes("url=")) {
              directGoogleUrl = decodeURIComponent(loc.split("url=")[1]);
            } else if (loc.includes("googleusercontent.com") || loc.startsWith("http")) {
              directGoogleUrl = loc;
            }
            if (directGoogleUrl && directGoogleUrl.startsWith("http")) {
              streamLinks.push({ server: "Instant Download", link: directGoogleUrl, type: "mkv" });
            }
          } else if (typeof vRes.data === "string") {
            const upMatch = vRes.data.match(/window\.location\.href\s*=\s*["']([^"']+)["']/);
            if (upMatch) {
              const upPath = upMatch[1];
              const vOrigin = new URL(seed).origin;
              const upUrl = upPath.startsWith("http") ? upPath : vOrigin + upPath;
              const upRes = await axios.get(upUrl, {
                headers: { ...headers, Referer: seed },
                signal,
              });
              const loc2 = upRes.headers?.location;
              if (loc2 && loc2.startsWith("http")) {
                streamLinks.push({ server: "Instant Download", link: loc2, type: "mkv" });
              } else if (typeof upRes.data === "string") {
                const $up = cheerio.load(upRes.data);
                const dlBtn = $up("#downloadBtn, a.btn-danger, a.btn-success").attr("href");
                if (dlBtn && dlBtn.startsWith("http")) {
                  streamLinks.push({ server: "Instant Download", link: dlBtn, type: "mkv" });
                }
              }
            }
          }
        } catch {}
      }
    } catch {}

    return streamLinks;
  } catch (error) {
    return streamLinks;
  }
}
