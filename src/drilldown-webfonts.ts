type Triple = `${string}||${string}||${string}`

// ------------ caches ------------
const fontDataUrlCache = new Map<string, string>() // url -> data:...
const inlinedFaceCache = new Map<string, string>() // rule signature -> @font-face{...}
const embedCssForTriplesCache = new Map<string, string>() // sorted triple list -> CSS

// data URL fetch with memoization
const urlToDataUrl = async (url: string): Promise<string> => {
    const cached = fontDataUrlCache.get(url)
    if (cached) return cached

    const res = await fetch(url, { mode: 'cors', cache: 'force-cache' })
    if (!res.ok) throw new Error(`Font fetch failed: ${url} (${res.status})`)
    const blob = await res.blob()
    const dataUrl = await new Promise<string>((resolve) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.readAsDataURL(blob)
    })

    fontDataUrlCache.set(url, dataUrl)
    return dataUrl
}

// 1) collect used families/weights/styles in subtree
const collectUsedTriples = (root: HTMLElement): Set<Triple> => {
    const triples = new Set<Triple>()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    for (
        let el = walker.currentNode as HTMLElement;
        el;
        el = walker.nextNode() as HTMLElement
    ) {
        const cs = getComputedStyle(el)
        const families = cs.fontFamily
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        const family = families[0]
        if (!family || /^(serif|sans-serif|monospace|system-ui|ui-)/i.test(family))
            continue
        const style = (cs.fontStyle || 'normal').trim() || 'normal'
        let weight = (cs.fontWeight || '400').toString().trim()
        if (weight === 'normal') weight = '400'
        if (weight === 'bold') weight = '700'
        triples.add(`${family}||${weight}||${style}`)
    }

    return triples
}

// 2) find matching @font-face rules for those triples
const getMatchingFontFaceRules = (triples: Set<Triple>): CSSFontFaceRule[] => {
    const out: CSSFontFaceRule[] = []
    const want = new Set(Array.from(triples).map((t) => t.toLowerCase()))
    for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try {
            rules = (sheet as CSSStyleSheet).cssRules
        } catch {
            continue // cross-origin stylesheet
        }
        for (const rule of Array.from(rules)) {
            if ((rule as CSSFontFaceRule).type !== CSSRule.FONT_FACE_RULE) continue
            const ff = rule as CSSFontFaceRule
            const family = ff.style
                .getPropertyValue('font-family')
                .trim()
                .replace(/^['"]|['"]$/g, '')
            if (!family) continue
            const style =
                (ff.style.getPropertyValue('font-style') || 'normal').trim() || 'normal'
            let weight = (ff.style.getPropertyValue('font-weight') || '400').trim()
            if (weight === 'normal') weight = '400'
            if (weight === 'bold') weight = '700'
            const key = `${family}||${weight}||${style}`.toLowerCase()
            if (want.has(key)) out.push(ff)
        }
    }

    return out
}

// 3) inline one @font-face’s src to data URL (memoized)
const inlineFontFace = async (
    rule: CSSFontFaceRule,
): Promise<string | null> => {
    // build a stable cache key from the rule’s essential parts
    const family = rule.style.getPropertyValue('font-family').trim()
    const weight = (rule.style.getPropertyValue('font-weight') || '400').trim()
    const style = (rule.style.getPropertyValue('font-style') || 'normal').trim()
    const uRange = (rule.style.getPropertyValue('unicode-range') || '').trim()
    const cacheKey = `${family}||${weight}||${style}||${uRange}`

    const cached = inlinedFaceCache.get(cacheKey)
    if (cached) return cached

    const src = rule.style.getPropertyValue('src')
    const urls = Array.from(
        src.matchAll(/url\(([^)]+)\)\s*format\(['"]?([^'"]+)['"]?\)/g),
    ).map((m) => ({
        url: m[1].replace(/^['"]|['"]$/g, ''),
        format: m[2].toLowerCase(),
    }))

    const pick = urls.find((u) => u.format.includes('woff2')) ?? urls[0]
    if (!pick) return null

    const dataUrl = await urlToDataUrl(pick.url)

    const css =
        `@font-face{` +
        `font-family:${family};` +
        `font-style:${style || 'normal'};` +
        `font-weight:${weight || '400'};${uRange ? `unicode-range:${uRange};` : ''
        }src:url(${dataUrl}) format('woff2');` +
        `font-display:block;` +
        `}`

    inlinedFaceCache.set(cacheKey, css)

    return css
}

// 4) Build the fontEmbedCSS string for only the used faces, inlined (memoized by triples set)
export const buildFontEmbedCSS = async (root: HTMLElement): Promise<string> => {
    const triples = collectUsedTriples(root)
    if (!triples.size) {
        return ''
    }

    // memoize by a stable, sorted key
    const key = Array.from(triples).sort().join('|')
    const cached = embedCssForTriplesCache.get(key)
    if (cached) {
        return cached
    }

    const rules = getMatchingFontFaceRules(triples)
    const parts: string[] = []
    for (const r of rules) {
        const css = await inlineFontFace(r)
        if (css) parts.push(css)
    }
    const result = parts.join('\n')
    embedCssForTriplesCache.set(key, result)

    return result
}
