/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * Vega Provider Types Reference
 */

export interface Post {
  title: string;
  link: string;
  image: string;
  quality?: string;
  type?: 'movie' | 'series';
  releaseDate?: string;
}

export interface CatalogItem {
  title: string;
  filter: string;
}

export interface Subtitle {
  language: string;
  url: string;
  type?: 'vtt' | 'srt';
}

export interface Stream {
  server: string;
  link: string;
  type: 'm3u8' | 'mp4' | 'embed';
  quality?: string;
  headers?: Record<string, string>;
  subtitles?: Subtitle[];
}

export interface EpisodeLink {
  title: string;
  episode: number;
  link: string;
  season?: number;
}

export interface ProviderContext {
  axios?: any;
  cheerio?: any;
  commonHeaders?: Record<string, string>;
  fetch?: typeof fetch;
}
