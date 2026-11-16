import { getBaseUrl } from "../getBaseUrl";

const DEFAULT_CINEWOOD_BASE_URL = "https://one.1cinevood.baby";
let resolvedBaseUrl = "";

const wafSessionCache = new Map<
  string,
  { cookies?: string; userAgent?: string }
>();

export function normalizeCinewoodLink(rawUrl: string): string {
  if (!rawUrl || typeof rawUrl !== "string") return rawUrl;
  return rawUrl.replace(
    /^https?:\/\/(?:www\.)?mobilejsr\.(?:best|com|org|net|xyz|top|live|in)\//i,
    "https://nexdrive.store/",
  );
}

export async function getCinewoodBaseUrl(): Promise<string> {
  if (resolvedBaseUrl) return resolvedBaseUrl;

  try {
    const url = await getBaseUrl("1cinevood");
    if (
      !url ||
      /(?:cinevood\.rocks|cinevood\.business|cinewood\.business|cinevood\.cv)/i.test(
        url,
      )
    ) {
      resolvedBaseUrl = DEFAULT_CINEWOOD_BASE_URL;
      return resolvedBaseUrl;
    }
    resolvedBaseUrl = url.replace(/\/+$/, "");
    return resolvedBaseUrl;
  } catch {
    return DEFAULT_CINEWOOD_BASE_URL;
  }
}

export function isWafChallenge(html: string): boolean {
  if (!html || typeof html !== "string") return false;
  return (
    html.includes("<title>Just a moment...</title>") ||
    html.includes("challenges.cloudflare.com") ||
    html.includes("cf-mitigated") ||
    html.includes("cf-chl-widget") ||
    html.includes("Attention Required! | Cloudflare") ||
    (html.includes("Cloudflare Ray ID") && html.includes("Please wait"))
  );
}

export async function getWithWAF(
  rawUrl: string,
  axios: any,
  openWebView: any,
  headers: any,
): Promise<any> {
  const url = normalizeCinewoodLink(rawUrl);
  const baseUrl = url.split("/").slice(0, 3).join("/");
  const cachedSession = wafSessionCache.get(baseUrl);

  const reqHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    ...headers,
    Referer: `${baseUrl}/`,
  };

  if (cachedSession?.userAgent) {
    reqHeaders["User-Agent"] = cachedSession.userAgent;
  }
  if (cachedSession?.cookies) {
    reqHeaders["Cookie"] = cachedSession.cookies;
  }

  try {
    const res = await axios.get(url, { headers: reqHeaders });
    if (
      typeof res?.data === "string" &&
      isWafChallenge(res.data) &&
      openWebView
    ) {
      throw { response: { status: 403 } };
    }
    return res;
  } catch (error: any) {
    // If a genxfm URL failed on another mirror, try nexdrive.store before triggering openWebView
    if (url.includes("/genxfm") && !url.includes("nexdrive.store")) {
      try {
        const nexUrl = url.replace(/^https?:\/\/[^/]+\//i, "https://nexdrive.store/");
        const nexRes = await axios.get(nexUrl, {
          headers: { ...reqHeaders, Referer: "https://nexdrive.store/" },
        });
        if (typeof nexRes?.data === "string" && !isWafChallenge(nexRes.data)) {
          return nexRes;
        }
      } catch {}
    }

    if (
      (error.response?.status === 403 || error.response?.status === 503) &&
      openWebView
    ) {
      console.log(
        `WAF detected (${error.response?.status}) for ${url}, using solver...`,
      );
      const wafResult = await openWebView(url, {
        title: "Solve the captcha below and click done",
        description: "Required to bypass anti-bot protection.",
        headers: { ...reqHeaders, Referer: baseUrl },
        waitForCookie: "cf_clearance",
        force: true,
      });

      const solvedCookies = wafResult?.cookies || wafResult?.cookie;
      const solvedUa = wafResult?.userAgent || reqHeaders["User-Agent"];

      if (solvedCookies || solvedUa) {
        wafSessionCache.set(baseUrl, {
          cookies: solvedCookies,
          userAgent: solvedUa,
        });
      }

      if (
        wafResult?.data &&
        !isWafChallenge(wafResult.data) &&
        wafResult.data.trim().length > 50
      ) {
        return { data: wafResult.data, url: wafResult.url || url };
      }

      const targetUrl = wafResult?.url || url;
      const targetBaseUrl = targetUrl.split("/").slice(0, 3).join("/");
      return await axios.get(targetUrl, {
        headers: {
          ...reqHeaders,
          Referer: targetBaseUrl,
          "User-Agent": solvedUa,
          ...(solvedCookies ? { Cookie: solvedCookies } : {}),
        },
      });
    }
    throw error;
  }
}
