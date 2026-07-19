import { useEffect, type RefObject } from 'react'

/**
 * Dismiss an open popover/menu on an outside mousedown or the Escape key. Shared
 * by the composer's tools popover and the model picker so both close the same way.
 */
export function useDismissOnOutside(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}
