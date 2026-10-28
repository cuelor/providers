import path from "node:path";
import {
  computeBinding,
  replacePromptReferences,
  type ProviderContext,
  type ProviderDefinition,
} from "@cuelor/provider-sdk";
import { CATALOG } from "./catalog.ts";
import { FakeUpstream, type FakeKind } from "./fake-upstream.ts";

export const PROVIDER_ID = "example.fake";
export const PROVIDER_VERSION = "0.1.0";

// The fake upstream has no real key. The binding is derived from this account name, as a real plugin
// would derive it from the upstream key or account id.
const FAKE_ACCOUNT = "fake-account";

const KIND_BY_MODEL: Record<string, FakeKind> = {
  "example/fake-image": "image",
  "example/fake-video": "video",
  "example/fake-asr": "transcription",
};

/** The provider definition: catalog, account and the adapter between the protocol and the fake upstream. */
export function buildProvider(): ProviderDefinition {
  let upstream: FakeUpstream | undefined;
  const fake = (ctx: ProviderContext) => (upstream ??= new FakeUpstream({ dir: path.join(ctx.dataDir, "fake-upstream") }));

  return {
    id: PROVIDER_ID,
    name: "Fake Provider",
    version: PROVIDER_VERSION,
    repository: "https://github.com/cuelor/providers",
    capabilities: {
      generation: ["image", "video"],
      transcription: true,
      cancel: true,
      estimate: true,
      webhook: false,
      setup: false,
    },
    billingUnit: "USD",
    async account(ctx) {
      return { status: "ready", label: "Fake key", binding: await computeBinding(FAKE_ACCOUNT, { dataDir: ctx.dataDir }) };
    },
    catalog: () => CATALOG,
    upstream: {
      async submit(ctx) {
        const kind = KIND_BY_MODEL[ctx.model.id];
        if (!kind) throw new Error(`no fake upstream for ${ctx.model.id}`);
        const parameters = { ...ctx.request.parameters };
        // The fake upstream only takes an ordered list of inputs, so references are removed from the
        // prompt (v1.md section 3.6 rule 6) and the inputs are passed in position order.
        if (typeof parameters.prompt === "string") {
          parameters.prompt = replacePromptReferences(parameters.prompt, (ref) => `${ref.kind} ${ref.index}`);
        }
        const inputs = [];
        for (const input of ctx.inputs) inputs.push({ bytes: await input.read(), media_type: input.artifact.media_type });
        const upstreamId = await fake(ctx).submit({
          clientReference: ctx.clientReference,
          kind,
          model: ctx.model.id,
          route: ctx.route.id,
          parameters,
          inputs,
        });
        return { upstreamId };
      },
      poll: (upstreamId, ctx) => fake(ctx).status(upstreamId),
      lookup: (clientReference, ctx) => fake(ctx).findByClientReference(clientReference),
      cancel: (upstreamId, ctx) => fake(ctx).cancel(upstreamId),
      async estimate() {
        return { amount: 0, unit: "USD", basis: "exact", note: "the fake upstream is free" };
      },
    },
  };
}
