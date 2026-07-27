/** One open-weight model, as it appears on a card in the marquee. */
interface OpenModel {
  /** Model family and generation, as the weights are published. */
  name: string
  /** Who released the weights. */
  org: string
  /** Total parameter count — MoE models show the total, not the active slice. */
  size: string
  /** Licence the weights ship under. */
  license: string
}

/* Deliberately open-weight only: the point of the backdrop is that every card
   is a model you can download and point Lychee at, not a hosted endpoint. */
const MODELS: readonly OpenModel[] = [
  { name: 'Llama 3.3', org: 'Meta', size: '70B', license: 'Llama 3.3' },
  { name: 'Qwen3', org: 'Alibaba', size: '235B', license: 'Apache-2.0' },
  { name: 'DeepSeek-R1', org: 'DeepSeek', size: '671B', license: 'MIT' },
  { name: 'Mistral Small 3', org: 'Mistral AI', size: '24B', license: 'Apache-2.0' },
  { name: 'Gemma 3', org: 'Google', size: '27B', license: 'Gemma' },
  { name: 'gpt-oss', org: 'OpenAI', size: '120B', license: 'Apache-2.0' },
  { name: 'Phi-4', org: 'Microsoft', size: '14B', license: 'MIT' },
  { name: 'Kimi K2', org: 'Moonshot AI', size: '1T', license: 'Modified MIT' },
  { name: 'OLMo 2', org: 'Ai2', size: '32B', license: 'Apache-2.0' },
  { name: 'GLM-4.6', org: 'Z.ai', size: '355B', license: 'MIT' },
  { name: 'Command A', org: 'Cohere', size: '111B', license: 'CC-BY-NC' },
  { name: 'Devstral', org: 'Mistral AI', size: '24B', license: 'Apache-2.0' },
  { name: 'Nemotron Super', org: 'NVIDIA', size: '49B', license: 'NVIDIA Open' },
  { name: 'Granite 3.3', org: 'IBM', size: '8B', license: 'Apache-2.0' },
  { name: 'Qwen3-Coder', org: 'Alibaba', size: '480B', license: 'Apache-2.0' },
  { name: 'SmolLM3', org: 'Hugging Face', size: '3B', license: 'Apache-2.0' },
  { name: 'MiniMax-M2', org: 'MiniMax', size: '230B', license: 'MIT' },
  { name: 'Falcon 3', org: 'TII', size: '10B', license: 'TII Falcon' },
  { name: 'Yi 1.5', org: '01.AI', size: '34B', license: 'Apache-2.0' },
  { name: 'StarCoder2', org: 'BigCode', size: '15B', license: 'OpenRAIL-M' },
  { name: 'DeepSeek-V3', org: 'DeepSeek', size: '671B', license: 'MIT' },
  { name: 'Mixtral 8x22B', org: 'Mistral AI', size: '141B', license: 'Apache-2.0' },
  { name: 'DBRX', org: 'Databricks', size: '132B', license: 'Databricks Open' },
  { name: 'Hermes 3', org: 'Nous Research', size: '70B', license: 'Llama 3.1' },
  { name: 'Mistral NeMo', org: 'Mistral AI', size: '12B', license: 'Apache-2.0' },
]

/* The projected plane has to be big enough to reach the corners of a rotated
   viewport, which takes far more tiles than there are models worth naming — so
   the list cycles, the way a marquee's images do. CSS narrows the grid to six
   columns on desktop and keeps all eight on a phone, where a wide card would
   fill the screen — so the DOM always holds the larger count and `--cols`
   decides how many are drawn. */
const COLUMNS = 8
const ROWS = 12

/* Both strides are coprime with the model count, so no column repeats a model
   and none is a near-copy of another — walking the list one at a time makes
   columns two apart come out identical but for a single row's offset, which is
   exactly the repeat the eye picks up. */
const COL_STRIDE = 7
const ROW_STRIDE = 3

const COLUMN_CARDS = Array.from({ length: COLUMNS }, (_, col) =>
  Array.from({ length: ROWS }, (_, row) => MODELS[(col * COL_STRIDE + row * ROW_STRIDE) % MODELS.length]),
)

/**
 * The drifting isometric backdrop behind "Your model. Your rules." — a plane of
 * open-weight model cards, projected with rotateX/rotateZ, its columns eased up
 * and down forever. It is pure decoration: the section's own chips carry the
 * message, so the whole thing is `aria-hidden` and untouchable by the pointer.
 */
export default function ModelMarquee() {
  return (
    <div className="marquee3d" aria-hidden="true">
      <div className="marquee3d__stage">
        <div className="marquee3d__grid">
          {COLUMN_CARDS.map((cards, col) => (
            <div className="marquee3d__col" key={col}>
              {cards.map((m, row) => (
                <article className="model-card" key={`${col}-${row}`}>
                  <div className="model-card__head">
                    <span className="model-card__mark">{m.org.slice(0, 1)}</span>
                    <span className="model-card__org">{m.org}</span>
                  </div>
                  <h4 className="model-card__name">{m.name}</h4>
                  <div className="model-card__foot">
                    <span className="model-card__size">{m.size}</span>
                    <span className="model-card__license">{m.license}</span>
                  </div>
                </article>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
