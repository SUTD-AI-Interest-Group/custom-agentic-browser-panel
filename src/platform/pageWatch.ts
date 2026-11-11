import type { Observation } from '../data/pageWatches'

/** Read only; runs in the isolated world, including in inactive tabs. */
export async function observeWatchTarget(tabId: number, url: string, selector: string): Promise<Observation> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (expectedUrl: string, css: string) => {
      if (location.href !== expectedUrl) throw new Error('Page navigated or redirected. Recreate the watch on the correct page.')
      if (document.querySelector('input[type="password"]')) throw new Error('Page requires sign-in; watch needs attention.')
      const elements = document.querySelectorAll(css)
      if (elements.length !== 1) throw new Error('Target is missing or ambiguous. Select the component again.')
      const element = elements[0] as HTMLElement
      if (!element.getClientRects().length || getComputedStyle(element).visibility === 'hidden') throw new Error('Target is not visible in the document.')
      const text = element.innerText ?? element.textContent ?? ''
      if (text.length > 16000) throw new Error('Component is too large. Select a smaller area.')
      return { text, enabled: !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true', tag: element.tagName }
    },
    args: [url, selector],
  })
  if (!result?.result) throw new Error('Page returned no observation.')
  return result.result
}
