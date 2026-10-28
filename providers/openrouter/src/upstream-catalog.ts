// Reads OpenRouter's three model lists and keeps the catalog for a while. The lists are public; they are
// read without the key.

import { ProviderError, type Catalog } from "@cuelor/provider-sdk";
import { buildCatalog, type UpstreamImageModel, type UpstreamLists, type UpstreamModel, type UpstreamVideoModel } from "./catalog.ts";
import type { OpenRouterClient } from "./client.ts";

const FRESH_MS = 10 * 60_000;
/** After a failed refresh the last catalog is used for this long. */
const STALE_MS = 60 * 60_000;

export class CatalogSource {
  private readonly client: OpenRouterClient;
  private readonly now: () => number;
  private cached: { at: number; lists: UpstreamLists; catalog: Catalog } | undefined;
  private loading: Promise<{ lists: UpstreamLists; catalog: Catalog }> | undefined;

  constructor(client: OpenRouterClient, now: () => number = Date.now) {
    this.client = client;
    this.now = now;
  }

  async get(): Promise<{ lists: UpstreamLists; catalog: Catalog }> {
    const c = this.cached;
    if (c && this.now() - c.at < FRESH_MS) return c;
    this.loading ??= this.load().finally(() => (this.loading = undefined));
    try {
      return await this.loading;
    } catch (err) {
      if (c && this.now() - c.at < STALE_MS) return c;
      throw new ProviderError(502, "upstream_unavailable", `could not read OpenRouter's model lists: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async catalog(): Promise<Catalog> {
    return (await this.get()).catalog;
  }

  private async load(): Promise<{ lists: UpstreamLists; catalog: Catalog }> {
    const read = async <T>(path: string) => (await this.client.json<{ data?: T[] }>("GET", path, { auth: false, timeoutMs: 15_000 })).body.data ?? [];
    const [images, videos, transcription] = await Promise.all([
      read<UpstreamImageModel>("/api/v1/images/models"),
      read<UpstreamVideoModel>("/api/v1/videos/models"),
      read<UpstreamModel>("/api/v1/models?output_modalities=transcription"),
    ]);
    const lists = { images, videos, transcription };
    const entry = { at: this.now(), lists, catalog: buildCatalog(lists) };
    this.cached = entry;
    return entry;
  }
}
