// Tiny API client for /api/rimlist.
export async function api(method, args = {}) {
  const res = await fetch('/api/rimlist', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method, args }),
  })
  let body
  try {
    body = await res.json()
  } catch {
    throw new Error(`rimlist: bad response (${res.status})`)
  }
  if (!res.ok || !body.ok) throw new Error(body?.error || `rimlist: HTTP ${res.status}`)
  return body.result
}

export const previewUrl = (packageId) => `/api/rimlist/preview?id=${encodeURIComponent(packageId)}`
export const workshopUrl = (pfid) => `https://steamcommunity.com/sharedfiles/filedetails/?id=${pfid}`
export const steamSubscribeUrl = (pfid) => `steam://url/CommunityFilePage/${pfid}`

/** Subscribe to a Steam workshop mod (opens Steam client). */
export async function subscribeMod(pfid) {
  try {
    await api('subscribeMod', { publishedFileId: pfid })
  } catch (e) {
    console.error('Failed to subscribe:', e)
    throw e
  }
}

/** Unsubscribe from a Steam workshop mod (opens Steam client). */
export async function unsubscribeMod(pfid) {
  try {
    await api('unsubscribeMod', { publishedFileId: pfid })
  } catch (e) {
    console.error('Failed to unsubscribe:', e)
    throw e
  }
}

/** steam:// links do nothing inside the DSH webview, so ask the host to open them (xdg-open / start / open). */
export async function openSteam(pfid) {
  try {
    await api('openSteamPage', { publishedFileId: pfid })
  } catch {
    window.open(workshopUrl(pfid), '_blank', 'noopener')
  }
}
/** onClick handler for an <a href=workshopUrl> that should open in the Steam client. */
export const steamClick = (pfid) => (e) => {
  e.preventDefault()
  openSteam(pfid)
}
