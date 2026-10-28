import { ProviderContext, Stream } from "../types";

// This provider currently exposes catalog and episode-page metadata only.
// It intentionally does not resolve third-party download hosts into streams.
export async function getStream({
  link,
  providerContext,
}: {
  link: string;
  type: string;
  signal?: AbortSignal;
  providerContext: ProviderContext;
  isDownload?: boolean;
}): Promise<Stream[]> {
  void link;
  void providerContext;
  return [];
}
