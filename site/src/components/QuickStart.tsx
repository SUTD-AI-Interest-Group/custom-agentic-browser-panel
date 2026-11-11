import { Cta } from '../App'
import StepMock, { type StepVariant } from './StepMock'

/**
 * The quick-start section.
 *
 * It is the one section on the page that closes the loop from "here is what it
 * does" to "here is how you start", so it carries the only CTA between the hero
 * and the closing band. Deliberately *not* scroll-driven: the two sections
 * immediately before it already pin the viewport (Features, PermissionScrub),
 * and a third would be scroll fatigue rather than rhythm. Everything here
 * resolves in one screen.
 */

interface Step {
  n: number
  title: string
  body: string
  scene: StepVariant
}

const STEPS: Step[] = [
  {
    n: 1,
    title: 'Install',
    body: 'Add Lychee to Chrome from the Web Store and pin it to your toolbar.',
    scene: 'install',
  },
  {
    n: 2,
    title: 'Connect a model',
    body: 'Paste an API key, or point it at Ollama or LM Studio on your own machine.',
    scene: 'connect',
  },
  {
    n: 3,
    title: 'Say hello',
    body: 'Open any page, open the panel, and ask it something.',
    scene: 'ask',
  },
]

export default function QuickStart() {

  return (
    <section className="band--page" id="quickstart">
      <div className="shell section quickstart reveal">
        <div className="section__head section__head--center">
          <h2>Setup</h2>
        </div>

        <ol className="quicksteps">
          {STEPS.map((s) => (
            <li className="quickstep" key={s.title}>
              <div className="quickstep__mark">
                <span className="quickstep__n">{s.n}</span>
              </div>
              <div className="quickstep__frame">
                <StepMock variant={s.scene} />
              </div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>

        <div className="quickstart__cta">
          <Cta />
          <p className="quickstart__meta">Chrome 116+ · Works in Edge, Brave, Arc and Vivaldi too</p>
        </div>
      </div>
    </section>
  )
}
