/**
 * Attach the plugin stylesheet once per document.
 *
 * The out-of-tree client bundle has no stylesheet pipeline, so the CSS ships as
 * a string. Every surface the plugin draws calls this, because the tab and the
 * settings page can be the first one mounted.
 * @module dsh-browser/client/useStyle
 */
import { useEffect } from 'react'
import { STYLE_ID, STYLE_TEXT } from './style.ts'

/** Attach the stylesheet, once, if it is not already present. */
export function usePluginStyle(): void {
  useEffect(() => {
    if (document.getElementById(STYLE_ID) !== null) return
    const tag = document.createElement('style')
    tag.id = STYLE_ID
    tag.textContent = STYLE_TEXT
    document.head.appendChild(tag)
  }, [])
}
