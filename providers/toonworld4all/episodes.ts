/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Vega Provider Episodes Module
 */

import { EpisodeLink, ProviderContext } from './types.ts';

export const getEpisodes = async ({
  url,
  providerContext,
}: {
  url: string;
  signal?: AbortSignal;
  providerContext?: ProviderContext;
}): Promise<EpisodeLink[]> => {
  let html = '';
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Referer: 'https://toonworld4all.me/',
    ...(providerContext?.commonHeaders || {}),
  };

  if (providerContext?.axios) {
    const res = await providerContext.axios.get(url, { headers });
    html = res.data;
  } else {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    html = await res.text();
  }

  const cheerio = providerContext?.cheerio || (await import('cheerio'));
  const $ = cheerio.load(html);
  const episodes: EpisodeLink[] = [];

  // Parse accordion items (ToonWorld4All modern format)
  $('.mks_accordion_item').each((i: number, el: any) => {
    const item = $(el);
    const heading = item.find('.mks_accordion_heading').text().trim();
    const link = item.find('a.mks_button, a[href*="archive.toonworld4all.me"]').first().attr('href');

    if (!link) return;

    const epMatch = heading.match(/(?:Episode|Ep\.?)\s*(\d+)/i);
    const episode = epMatch ? parseInt(epMatch[1], 10) : i + 1;

    const seasonMatch = heading.match(/Season\s*(\d+)|S(\d+)E\d+/i);
    const season = seasonMatch ? parseInt(seasonMatch[1] || seasonMatch[2], 10) : 1;

    episodes.push({
      title: heading.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || `Episode ${episode}`,
      episode,
      link,
      season,
    });
  });

  return episodes;
};
