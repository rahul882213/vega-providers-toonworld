const urlsEndpoint =
  "https://raw.githubusercontent.com/rahul882213/vega-providers-toonworld/refs/heads/main/urls.json";
const cacheTtl = 60 * 60 * 1000;

type ProviderUrls = Record<string, { url: string }>;

const defaultProviderUrls: ProviderUrls = {
  "1cinevood": { url: "https://one.1cinevood.baby" },
  cinevood: { url: "https://one.1cinevood.baby" },
  w4u: { url: "https://world4ufree.co.in" },
  world4u: { url: "https://world4ufree.co.in" },
  lux: { url: "https://rogmovies.digital" },
  luxMovies: { url: "https://rogmovies.digital" },
  bollyflix: { url: "https://bollyflix.church" },
  toonworld4all: { url: "https://toonworld4all.me" },
};

const outdatedHostPattern =
  /(?:cinevood\.business|cinewood\.business|cinevood\.rocks|cinevood\.cv|world4ufree\.vu|world4ufree\.ind\.in|rogmovies\.cyou|roamovies\.cyou|bollyflix\.tours|bollyflix\.composable)/i;

function normalizeProviderUrls(data?: ProviderUrls): ProviderUrls {
  const merged: ProviderUrls = { ...defaultProviderUrls };
  if (data && typeof data === "object") {
    for (const [key, entry] of Object.entries(data)) {
      const candidate = entry?.url?.replace(/\/+$/, "") || "";
      if (!candidate) continue;
      if (outdatedHostPattern.test(candidate) && defaultProviderUrls[key]?.url) {
        merged[key] = defaultProviderUrls[key];
      } else {
        merged[key] = { url: candidate };
      }
    }
  }
  return merged;
}

type BaseUrlCache = {
  data?: ProviderUrls;
  expiresAt: number;
  request?: Promise<ProviderUrls>;
};

type ProviderState = {
  __vegaProviderBaseUrlCache__?: BaseUrlCache;
};

declare const providerGlobal: ProviderState | undefined;

function getCache(): BaseUrlCache {
  const state =
    typeof providerGlobal !== "undefined" && providerGlobal
      ? providerGlobal
      : (globalThis as typeof globalThis & ProviderState);

  state.__vegaProviderBaseUrlCache__ ??= { expiresAt: 0 };
  return state.__vegaProviderBaseUrlCache__;
}

async function fetchProviderUrls(): Promise<ProviderUrls> {
  const cache = getCache();
  if (cache.data && Date.now() < cache.expiresAt) {
    return cache.data;
  }

  if (cache.request) {
    return cache.request;
  }

  const request = fetch(urlsEndpoint)
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`URL configuration request failed: ${response.status}`);
      }

      const rawData = (await response.json()) as ProviderUrls;
      const data = normalizeProviderUrls(rawData);
      console.log("Fetched provider URL configuration");
      cache.data = data;
      cache.expiresAt = Date.now() + cacheTtl;
      return data;
    })
    .catch((error) => {
      if (cache.data) {
        console.warn("Using stale provider URL configuration", error);
        return cache.data;
      }
      console.warn("Using built-in provider URL configuration fallback", error);
      const fallback = normalizeProviderUrls();
      cache.data = fallback;
      cache.expiresAt = Date.now() + cacheTtl;
      return fallback;
    })
    .finally(() => {
      cache.request = undefined;
    });

  Object.defineProperty(cache, "request", {
    configurable: true,
    enumerable: false,
    value: request,
    writable: true,
  });

  return request;
}

export const getBaseUrl = async (providerValue: string) => {
  try {
    const providerUrls = await fetchProviderUrls();
    return (
      providerUrls[providerValue]?.url ??
      defaultProviderUrls[providerValue]?.url ??
      ""
    );
  } catch (error) {
    console.error(`Error fetching baseUrl: ${providerValue}`, error);
    return defaultProviderUrls[providerValue]?.url ?? "";
  }
};
