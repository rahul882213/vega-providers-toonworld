import { ProviderContext, Stream } from "../types";
import { throwProviderError } from "../providerErrors";
import { vidboltExtractor } from "../extractors/vidbolt";
import { hubcloudExtractor } from "../extractors/hubcloud";
import { gdflixExtractor } from "../extractors/gdflix";
import { getMeta as getCinewoodMeta } from "../1cinevood/meta";
import { getEpisodes as getCinewoodEpisodes } from "../1cinevood/episodes";
import { getStream as getCinewoodStream } from "../1cinevood/stream";
import { getMeta as getBollyflixMeta } from "../bollyflix/meta";
import { getEpisodes as getBollyflixEpisodes } from "../bollyflix/episodes";
import { getStream as getBollyflixStream } from "../bollyflix/stream";
import { lookupTmdbByTitleAndPoster, readW4uMeta, W4uStreamMeta } from "./meta";
import { getWorld4uBaseUrl } from "./posts";

const defaultHeaders: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

function normalizeTitleForMatch(raw: string): string {
  return (raw || "")
    .toLowerCase()
    .replace(/\(\d{4}\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleMatchesCandidate(targetTitle: string, candidateTitle: string): boolean {
  const normTarget = normalizeTitleForMatch(targetTitle);
  const normCand = normalizeTitleForMatch(candidateTitle);
  if (!normTarget || !normCand) return false;
  if (normCand.includes(normTarget) || normTarget.includes(normCand)) return true;
  const words = normTarget.split(" ").filter((w) => w.length >= 3);
  if (words.length === 0) return false;
  const matched = words.filter((w) => normCand.includes(w));
  return matched.length >= Math.ceil(words.length * 0.6);
}

async function resolveFromPartnerNetwork({
  title,
  season,
  episode,
  effectiveType,
  signal,
  providerContext,
}: {
  title: string;
  season: number;
  episode: number;
  effectiveType: "movie" | "series";
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Stream[]> {
  const { axios, cheerio, commonHeaders } = providerContext;
  const safeContext: ProviderContext = {
    ...providerContext,
    openWebView: undefined as any,
  };

  const cleanQuery = title
    .replace(/\(\d{4}\)/g, "")
    .replace(/[:\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanQuery) return [];

  const queryVariants = [cleanQuery];
  const words = cleanQuery.split(" ").filter(Boolean);
  if (words.length > 2) {
    queryVariants.push(words.slice(-2).join(" "));
    queryVariants.push(words.slice(0, 2).join(" "));
  }

  // 1. Try 1CineVood & Zeefliz mirrors
  const cineMirrors = ["https://one.1cinevood.baby", "https://zeefliz1.xyz"];
  for (const mirror of cineMirrors) {
    for (const q of queryVariants) {
      try {
        const searchUrl = `${mirror}/?s=${encodeURIComponent(q)}`;
        const res = await axios.get(searchUrl, {
          headers: { ...defaultHeaders, ...commonHeaders, Referer: `${mirror}/` },
          signal,
          timeout: 8000,
        });
        const $ = cheerio.load(res.data || "");
        let matchedHref = "";
        $("article").each((_: number, el: any) => {
          if (matchedHref) return;
          const a = $(el).find("h2 a, h3 a, a[href]").first();
          const href = a.attr("href") || "";
          const t = a.attr("title") || a.text().trim() || $(el).text().trim();
          if (href && titleMatchesCandidate(cleanQuery, t)) {
            matchedHref = href;
          }
        });

        if (matchedHref) {
          const info = await getCinewoodMeta({
            link: matchedHref,
            providerContext: safeContext,
          });
          if (info?.linkList && info.linkList.length > 0) {
            for (const linkItem of info.linkList.slice(0, 2)) {
              if (linkItem.directLinks && linkItem.directLinks.length > 0) {
                const s = await getCinewoodStream({
                  link: linkItem.directLinks[0].link,
                  type: effectiveType,
                  signal,
                  providerContext: safeContext,
                });
                if (Array.isArray(s) && s.length > 0) return s;
              } else if (linkItem.episodesLink) {
                const eps = await getCinewoodEpisodes({
                  url: linkItem.episodesLink,
                  providerContext: safeContext,
                });
                if (Array.isArray(eps) && eps.length > 0) {
                  const targetEp =
                    eps.find((e) => {
                      const m = e.title.match(/(\d+)/);
                      return m && Number(m[1]) === episode;
                    }) || eps[0];
                  const s = await getCinewoodStream({
                    link: targetEp.link,
                    type: effectiveType,
                    signal,
                    providerContext: safeContext,
                  });
                  if (Array.isArray(s) && s.length > 0) return s;
                }
              }
            }
          }
        }
      } catch {}
    }
  }

  // 2. Try BollyFlix mirror
  for (const q of queryVariants) {
    try {
      const bfBase = "https://new1.bollyflix.tours";
      const searchUrl = `${bfBase}/?s=${encodeURIComponent(q)}`;
      const res = await axios.get(searchUrl, {
        headers: { ...defaultHeaders, ...commonHeaders, Referer: `${bfBase}/` },
        signal,
        timeout: 8000,
      });
      const $ = cheerio.load(res.data || "");
      let matchedHref = "";
      $("article").each((_: number, el: any) => {
        if (matchedHref) return;
        const a = $(el).find("h2 a, a.post-image, a[href]").first();
        const href = a.attr("href") || "";
        const t = a.text().trim() || a.attr("title") || "";
        if (href && titleMatchesCandidate(cleanQuery, t)) {
          matchedHref = href;
        }
      });

      if (matchedHref) {
        const info = await getBollyflixMeta({
          link: matchedHref,
          providerContext: safeContext,
        });
        if (info?.linkList && info.linkList.length > 0) {
          for (const linkItem of info.linkList.slice(0, 2)) {
            if (linkItem.directLinks && linkItem.directLinks.length > 0) {
              const s = await getBollyflixStream({
                link: linkItem.directLinks[0].link,
                type: effectiveType,
                signal,
                providerContext: safeContext,
              });
              if (Array.isArray(s) && s.length > 0) return s;
            } else if (linkItem.episodesLink) {
              const eps = await getBollyflixEpisodes({
                url: linkItem.episodesLink,
                providerContext: safeContext,
              });
              if (Array.isArray(eps) && eps.length > 0) {
                const targetEp =
                  eps.find((e) => {
                    const m = e.title.match(/(\d+)/);
                    return m && Number(m[1]) === episode;
                  }) || eps[0];
                const s = await getBollyflixStream({
                  link: targetEp.link,
                  type: effectiveType,
                  signal,
                  providerContext: safeContext,
                });
                if (Array.isArray(s) && s.length > 0) return s;
              }
            }
          }
        }
      }
    } catch {}
  }

  return [];
}

async function resolveZetaflixStreams({
  pageUrl,
  meta,
  type,
  signal,
  providerContext,
}: {
  pageUrl: string;
  meta: W4uStreamMeta;
  type: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Stream[]> {
  const { axios, cheerio, commonHeaders } = providerContext;
  const baseUrl = await getWorld4uBaseUrl();
  const streams: Stream[] = [];

  let html = "";
  try {
    const res = await axios.get(pageUrl, {
      signal,
      headers: {
        ...defaultHeaders,
        ...commonHeaders,
        Referer: `${baseUrl}/`,
      },
      timeout: 10000,
    });
    html = typeof res.data === "string" ? res.data : "";
  } catch {}

  const $ = html ? cheerio.load(html) : null;

  let title = meta.title || "";
  let year = meta.year || "";
  let posterFile = meta.posterFile || "";
  let season = Number(meta.season || 1);
  let episode = Number(meta.episode || 1);
  const effectiveType: "movie" | "series" =
    meta.type === "series" ||
    type === "series" ||
    /\/(?:episodes|tvshows)\//i.test(pageUrl)
      ? "series"
      : "movie";

  const epSlugMatch = pageUrl.match(/[-/](\d+)x(\d+)\/?$/i);
  if (epSlugMatch) {
    season = Number(epSlugMatch[1]) || season;
    episode = Number(epSlugMatch[2]) || episode;
  }

  let trailerEmbedUrl = "";

  if ($) {
    if (!title) {
      const serieText = $(".details-info, .info-col")
        .text()
        .match(/Serie:\s*([^\n\r]+)/i)?.[1];
      title = (
        serieText ||
        $(".details-title h3, .details-title h1, h1")
          .first()
          .text()
          .replace(/:\s*\d+\s*[x×]\s*\d+.*$/i, "")
      ).trim();
    }
    if (!year) {
      year =
        $(".details-info, .info-col")
          .text()
          .match(/Year:\s*(\d{4})/i)?.[1] || "";
    }
    if (!posterFile) {
      const posterSrc =
        $(".content-poster img").attr("src") ||
        $("meta[property='og:image']").attr("content") ||
        "";
      posterFile = posterSrc.split("/").pop()?.split("?")[0] || "";
    }

    // 1. Check Zetaflix player options (excluding "fake")
    const playerOptions = $(
      "#playeroptionsul li.zetaflix_player_option, .zetaflix_player_option",
    ).toArray();

    for (const optEl of playerOptions) {
      const opt = $(optEl);
      const post = opt.attr("data-post") || meta.postId || "";
      const pType =
        opt.attr("data-type") || (effectiveType === "series" ? "ep" : "mv");
      const nume = opt.attr("data-nume") || "";
      const serverLabel =
        opt.find(".title, .server").text().trim() ||
        opt.text().replace(/\s+/g, " ").trim() ||
        `Server ${nume}`;

      if (!post || !nume || nume === "fake") continue;

      try {
        const body = new URLSearchParams({
          action: "zeta_player_ajax",
          post,
          nume,
          type: pType,
        });
        const ajaxRes = await axios.post(
          `${baseUrl}/wp-admin/admin-ajax.php`,
          body.toString(),
          {
            signal,
            headers: {
              ...defaultHeaders,
              ...commonHeaders,
              "Content-Type": "application/x-www-form-urlencoded",
              Referer: pageUrl,
            },
            timeout: 8000,
          },
        );
        const embedData = ajaxRes.data;
        let embedUrl =
          typeof embedData === "object" ? embedData?.embed_url || "" : "";
        if (embedUrl && embedUrl.includes("<iframe")) {
          const $iframe = cheerio.load(embedUrl);
          embedUrl = $iframe("iframe").attr("src") || "";
        }
        if (!embedUrl || !embedUrl.startsWith("http")) continue;

        if (nume === "trailer" || /youtube\.com|youtu\.be/i.test(embedUrl)) {
          trailerEmbedUrl = embedUrl;
          continue;
        }

        const ext = embedUrl.includes(".m3u8")
          ? "m3u8"
          : embedUrl.includes(".mp4")
            ? "mp4"
            : embedUrl.includes(".mkv")
              ? "mkv"
              : "m3u8";

        streams.push({
          server: serverLabel,
          link: embedUrl,
          type: ext,
        });
      } catch {}
    }

    // 2. Check #links / download table links
    $(
      "#links a[href], .download-links a[href], a[href*='hubcloud'], a[href*='gdflix'], a[href*='vcloud']",
    ).each((_, a) => {
      const href = $(a).attr("href") || "";
      if (!href || href === "#" || href.startsWith("javascript:")) return;
      if (/hubcloud|vcloud|gdflix|fastdl|mediafire|photolinx/i.test(href)) {
        streams.push({
          server: $(a).text().trim() || "Download Link",
          link: href,
          type: "mkv",
        });
      }
    });

    const resolvedLockerStreams: Stream[] = [];
    for (const s of streams) {
      if (/hubcloud|vcloud/i.test(s.link)) {
        try {
          const hc = await hubcloudExtractor(
            s.link,
            signal,
            axios,
            cheerio,
            commonHeaders,
            { ...providerContext, openWebView: undefined as any },
            false,
            "world4u",
          );
          if (Array.isArray(hc)) resolvedLockerStreams.push(...hc);
        } catch {}
      } else if (/gdflix/i.test(s.link)) {
        try {
          const gd = await gdflixExtractor(
            s.link,
            signal,
            axios,
            cheerio,
            commonHeaders,
            { ...providerContext, openWebView: undefined as any },
          );
          if (Array.isArray(gd)) resolvedLockerStreams.push(...gd);
        } catch {}
      } else {
        resolvedLockerStreams.push(s);
      }
    }

    if (resolvedLockerStreams.length > 0) {
      return resolvedLockerStreams;
    }
  }

  // 3. Resolve from partner network (1CineVood, Zeefliz, BollyFlix) by title & season/episode
  if (title) {
    const partnerStreams = await resolveFromPartnerNetwork({
      title,
      season,
      episode,
      effectiveType,
      signal,
      providerContext,
    });
    if (partnerStreams.length > 0) {
      return partnerStreams;
    }
  }

  // 4. Resolve TMDB ID and query VidBolt (api.movy.lol)
  let tmdbId = meta.tmdbId || "";
  if (!tmdbId && title) {
    const tmdbInfo = await lookupTmdbByTitleAndPoster({
      title,
      year,
      type: effectiveType,
      posterFile,
      axios,
    });
    if (tmdbInfo?.tmdbId) {
      tmdbId = tmdbInfo.tmdbId;
    }
  }

  if (tmdbId) {
    try {
      const vbUrl =
        effectiveType === "series"
          ? `https://vidbolt.xyz/tv/${tmdbId}/${season}/${episode}?title=${encodeURIComponent(title)}`
          : `https://vidbolt.xyz/movie/${tmdbId}?title=${encodeURIComponent(title)}&year=${encodeURIComponent(year)}`;
      const vbStreams = await vidboltExtractor(
        vbUrl,
        signal,
        axios,
        cheerio,
        commonHeaders || defaultHeaders,
        providerContext,
      );
      if (Array.isArray(vbStreams) && vbStreams.length > 0) {
        return vbStreams;
      }
    } catch {}
  }

  // 5. Last-resort trailer fallback
  if (streams.length === 0 && trailerEmbedUrl) {
    streams.push({
      server: "World4uFree Official Trailer",
      link: trailerEmbedUrl,
      type: "m3u8",
      quality: "720",
    });
  }

  return streams;
}

export const getStream = async function ({
  link: rawUrl,
  type,
  signal,
  providerContext,
}: {
  link: string;
  type: string;
  signal: AbortSignal;
  providerContext: ProviderContext;
}): Promise<Stream[]> {
  const { axios, cheerio, commonHeaders: headers } = providerContext;
  try {
    const { requestUrl, meta } = readW4uMeta(rawUrl);
    let url = requestUrl;

    if (
      /world4ufree\.co\.in/i.test(url) ||
      /\/(?:movies|tvshows|episodes)\//i.test(url) ||
      meta.postId ||
      meta.tmdbId ||
      meta.title
    ) {
      const zetaStreams = await resolveZetaflixStreams({
        pageUrl: url,
        meta,
        type,
        signal,
        providerContext,
      });
      if (zetaStreams.length > 0) {
        return zetaStreams;
      }
    }

    return [];
  } catch (err) {
    throwProviderError("World4u", "stream", err);
  }
};
