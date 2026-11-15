# Mirage license provenance correction

Rechecked 2026-11-15 for the decision-classifier experiment. The original evaluation correctly recorded that its pinned model revision did not expose license metadata. The model publisher has since added an explicit Apache-2.0 declaration. This updates the deployment conclusion without rewriting the historical benchmark inputs.

| Evidence | Original evaluation pin | Updated preparation pin |
| --- | --- | --- |
| Model revision | `76c1e9e53381aca8fc3843c636216c96ff220122` | `3d03cee88c0acbe4e71b94b567ab14e6e55f40c9` |
| Model-card license metadata | absent | `license: apache-2.0` |
| `mirage.cact` bytes | 21,611,043 | 21,611,043 |
| Weight SHA-256 | `4249a0f7515272ff76b9414bec17d7e7daf84b15b66c7fb4f17fce1e66f9f237` | identical |

The Hugging Face API tree reports the current weight's LFS SHA-256 matching the earlier locally verified artifact. Both the [pinned updated model card](https://huggingface.co/Cactus-Compute/mirage/blob/3d03cee88c0acbe4e71b94b567ab14e6e55f40c9/README.md) and its API metadata declare Apache-2.0. The [historical card](https://huggingface.co/Cactus-Compute/mirage/blob/76c1e9e53381aca8fc3843c636216c96ff220122/README.md) has no such declaration. The runtime's separate Apache-2.0 evidence and pin are unchanged.

`scripts/prepare-mirage.mjs` now pins the licensed-card revision, verifies the unchanged weight hash, and packages the model card plus a copy of Apache-2.0 in `MODEL_CARD.md` and `LICENSE.model`. The card SHA-256 is `9c69381d336583e6b4069663f4028aeee9c0512d5abc6781c63d96ff54554d4f`. The Apache-2.0 text is identical to the runtime license already verified by checksum. No additional license acknowledgment flag is required; the old flag remains accepted for command compatibility. Generated binary/model assets remain ignored by Git. Retain these notices when distributing the optional bundle.

The original `docs/benchmarks/mirage-results.json` continues to record its actual older model revision; its bytes are identical, so the license-metadata update does not require changing or rerunning those historical measurements.
