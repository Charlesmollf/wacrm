// ============================================================
// Product image lookup for AI replies.
//
// Maps Kaffeejager product/combo names to their public Shopify CDN
// image URLs (pulled from kaffeejager.shop/products.json). The AI is
// instructed to tag recommendations with a `[[IMG: <name>]]` marker;
// `extractImageMarkers` pulls those out, resolves them to image URLs,
// and strips the markers from the customer-facing text so the reply
// reads clean and the code sends the matching photos after it.
//
// Codes/URLs are stable as long as the Shopify catalog isn't changed.
// If products are added/renamed, update this map.
// ============================================================

const CDN = 'https://cdn.shopify.com/s/files/1/0763/4790/0201/files'

/** Normalized product name -> public image URL. Keys are normalized via
 *  `norm()` below (lowercase, no accents, no "(400gr)"/"combo"). */
const PRODUCT_IMAGES: Record<string, string> = {
  bourbon: `${CDN}/Bourbon_2e81ebd9-b08d-48c1-8e91-00b178a2672e.jpg?v=1741931168`,
  catuai: `${CDN}/Catuai_5281fe78-f3f3-489a-8832-7df92f4399f3.jpg?v=1741930560`,
  'mitico coban': `${CDN}/MiticoCoban_412adabf-fb03-45ad-8e73-da128e26b6b3.jpg?v=1738638927`,
  'kenia sl28': `${CDN}/KeniaSL28_636f48dc-2507-4bf0-8fcd-bba3c0ecd659.jpg?v=1738639481`,
  gesha: `${CDN}/Gesha_70ce4d8a-d089-4203-8688-db17ec5e32ed.jpg?v=1738639477`,
  'caturra roja': `${CDN}/CaturraRoja.jpg?v=1738639477`,
  peaberry: `${CDN}/Peaberry.jpg?v=1738639489`,
  caracolillo: `${CDN}/Peaberry.jpg?v=1738639489`,
  anaerobico: `${CDN}/Anaerobico_ab1c3ff6-4527-42f0-8c02-10241dbe75cd.jpg?v=1738639474`,
  maracaturra: `${CDN}/Maracaturra_e8c5c0f7-3a1d-445a-a7df-121ed3a86896.jpg?v=1738639486`,
  maragogipe: `${CDN}/Maragogipe_3ed2e9ef-44e4-487c-beaf-8bb7720a22ab.jpg?v=1738639487`,
  pacamara: `${CDN}/Pacamara_32d1fc7c-a32f-498b-bba5-beb2dfc0d578.jpg?v=1738639488`,
  'africa mia': `${CDN}/AfricaMia.jpg?v=1738639251`,
  'procesos secretos': `${CDN}/ProcesosSecretos.jpg?v=1738639251`,
  'colosos de america': `${CDN}/ColososAmerica.jpg?v=1738639251`,
  'intensa dulzura': `${CDN}/Intensa_Dulzura.jpg?v=1738639250`,
}

/** Lowercase, strip accents, drop "combo"/"(400gr)" noise, collapse spaces. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/combo/g, ' ')
    .replace(/\(?\s*400\s*gr\s*\)?/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Resolve a raw product name to an image URL (exact, then substring). */
function resolveImage(rawName: string): string | null {
  const key = norm(rawName)
  if (!key) return null
  if (PRODUCT_IMAGES[key]) return PRODUCT_IMAGES[key]
  // Fuzzy: the marker contains a known key, or a key contains the marker.
  for (const [k, url] of Object.entries(PRODUCT_IMAGES)) {
    if (key.includes(k) || k.includes(key)) return url
  }
  return null
}

const MARKER = /\[\[\s*IMG\s*:\s*([^\]]+?)\s*\]\]/gi

export interface ExtractedImages {
  /** The reply text with all [[IMG:...]] markers removed. */
  cleanText: string
  /** Resolved images to send after the text (deduped, capped at 3). */
  images: { url: string; name: string }[]
}

/**
 * Pull `[[IMG: name]]` markers out of an AI reply, resolve each to a
 * product image URL, and return the cleaned text plus the images to
 * send. Unknown names are silently dropped (the text still sends).
 */
export function extractImageMarkers(text: string): ExtractedImages {
  const images: { url: string; name: string }[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  MARKER.lastIndex = 0
  while ((m = MARKER.exec(text)) !== null) {
    const name = m[1].trim()
    const url = resolveImage(name)
    if (url && !seen.has(url)) {
      seen.add(url)
      images.push({ url, name })
    }
  }
  const cleanText = text
    .replace(MARKER, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { cleanText, images: images.slice(0, 3) }
}
