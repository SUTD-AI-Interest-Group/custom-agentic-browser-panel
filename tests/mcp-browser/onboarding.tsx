// Loaded only by the explicit test harness; never an extension build entry.
// Uses real extension host permissions, but does not read or persist settings.
import {createRoot} from 'react-dom/client'
import {useState} from 'react'
import Onboarding from '../../src/ui/Onboarding'
import {defaultSettings} from '../../src/data/settings'
import '../../src/ui/styles.css'
function Harness(){
  const [done,setDone]=useState('')
  return done?<p role="status">{done}</p>:<Onboarding settings={defaultSettings()} onComplete={s=>setDone(`PASS onboarding: ${s.providers.at(-1)?.name}; ${s.selected?.modelId}; ${s.tabAccess}. No profile settings were changed.`)}/>
}
createRoot(document.getElementById('root')!).render(<Harness/> )
